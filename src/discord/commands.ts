import {
  ApplicationCommandOptionType,
  type ChatInputCommandInteraction,
  type Client,
  Events,
  type GuildMember,
} from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { notifyTranscribeWebhook, postprocessSession } from '../postprocess.js';
import { VoiceRecorder } from '../recorder.js';
import { RecordingSession } from '../session.js';

const activeSessions = new Map<string, { recorder: VoiceRecorder; session: RecordingSession }>();

export const SLASH_COMMANDS = [
  {
    name: 'scribe',
    description: 'ZAOscribe meeting recorder',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'start',
        description: 'Start recording the voice channel you are in',
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'stop',
        description: 'Stop recording, mix stems, hand off to the /meeting pipeline',
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: 'notes',
            description: 'Optional note attached to the session (e.g. meeting title)',
            required: false,
          },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'status',
        description: 'Show whether ZAOscribe is currently recording in this server',
      },
    ],
  },
] as const;

function isAuthorized(member: GuildMember | null): boolean {
  if (config.discord.adminUserIds.length === 0) return true;
  if (!member) return false;
  return config.discord.adminUserIds.includes(member.id);
}

async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !interaction.member) {
    await interaction.reply({ content: 'ZAOscribe only works inside a server.', ephemeral: true });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!isAuthorized(member)) {
    await interaction.reply({ content: 'You are not authorized to start ZAOscribe.', ephemeral: true });
    return;
  }

  const channel = member.voice.channel;
  if (!channel) {
    await interaction.reply({
      content: 'Join a voice channel first, then run `/scribe start` again.',
      ephemeral: true,
    });
    return;
  }

  if (activeSessions.has(interaction.guild.id)) {
    await interaction.reply({
      content: 'A ZAOscribe session is already running in this server. Use `/scribe stop` first.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const session = new RecordingSession({
    source: 'discord',
    startedBy: interaction.user.id,
    guildId: interaction.guild.id,
    channelId: channel.id,
    channelName: channel.name,
  });
  await session.init();

  const recorder = new VoiceRecorder(channel, session);
  await recorder.start();
  activeSessions.set(interaction.guild.id, { recorder, session });

  await interaction.editReply(
    `ZAOscribe is recording **${channel.name}**. Session id: \`${session.id}\`.\n` +
      'Bot will capture per-speaker stems. Run `/scribe stop` when done.',
  );
}

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: 'ZAOscribe only works inside a server.', ephemeral: true });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!isAuthorized(member)) {
    await interaction.reply({ content: 'You are not authorized to stop ZAOscribe.', ephemeral: true });
    return;
  }

  const active = activeSessions.get(interaction.guild.id);
  if (!active) {
    await interaction.reply({
      content: 'No active ZAOscribe session in this server.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const notes = interaction.options.getString('notes') ?? undefined;
  const { recorder, session } = active;
  activeSessions.delete(interaction.guild.id);

  const { stems } = await recorder.stop();
  await session.finalize(notes);

  await interaction.editReply(
    `Recording stopped. ${stems.length} stem(s) captured. Postprocessing + handoff to /meeting pipeline...`,
  );

  let { mixPath, stemWavs } = { mixPath: '', stemWavs: [] as string[] };
  try {
    const post = await postprocessSession(session);
    mixPath = post.mixPath;
    stemWavs = post.stemWavs;
  } catch (err) {
    logger.error({ err, sessionId: session.id }, 'discord:postprocess failed');
  }

  const webhookResult = await notifyTranscribeWebhook(
    config.transcribe.webhookUrl,
    config.transcribe.webhookSecret,
    {
      sessionId: session.id,
      source: 'discord',
      folder: session.folder,
      mixPath,
      stemWavs,
      participants: Object.fromEntries(
        Object.entries(session.meta.participants).map(([uid, p]) => [
          uid,
          { userId: p.userId, username: p.username, displayName: p.displayName },
        ]),
      ),
      startedAt: session.meta.startedAt,
      ...(session.meta.endedAt !== undefined ? { endedAt: session.meta.endedAt } : {}),
      ...(session.meta.channelName !== undefined ? { channelName: session.meta.channelName } : {}),
    },
  );

  const summaryLines = [
    `**Session** \`${session.id}\``,
    `**Stems** ${stems.length} - mixed to \`${mixPath || 'n/a'}\``,
    `**Folder** \`${session.folder}\``,
    `**Duration** ${session.meta.durationMs ? Math.round(session.meta.durationMs / 1000) + 's' : 'n/a'}`,
    `**Pipeline handoff** ${webhookResult.ok ? 'OK' : webhookResult.body ? `failed (${webhookResult.body})` : 'not configured'}`,
  ];

  await interaction.followUp({ content: summaryLines.join('\n'), ephemeral: false });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: 'ZAOscribe only works inside a server.', ephemeral: true });
    return;
  }
  const active = activeSessions.get(interaction.guild.id);
  if (!active) {
    await interaction.reply({ content: 'No active ZAOscribe session in this server.', ephemeral: true });
    return;
  }
  const { session } = active;
  const started = new Date(session.meta.startedAt);
  const elapsed = Math.round((Date.now() - started.getTime()) / 1000);
  await interaction.reply({
    content:
      `Recording session \`${session.id}\` in **${session.meta.channelName ?? 'unknown'}**.\n` +
      `Elapsed ${elapsed}s, ${session.participantCount()} speaker(s) captured so far.`,
    ephemeral: true,
  });
}

export function registerCommandHandlers(client: Client): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'scribe') return;
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === 'start') await handleStart(interaction);
      else if (sub === 'stop') await handleStop(interaction);
      else if (sub === 'status') await handleStatus(interaction);
    } catch (err) {
      logger.error({ err, sub }, 'discord:handler error');
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: `Error: ${errorMsg}`, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: `Error: ${errorMsg}`, ephemeral: true }).catch(() => {});
      }
    }
  });
}

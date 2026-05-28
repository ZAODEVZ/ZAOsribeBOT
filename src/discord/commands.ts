import {
  ActivityType,
  ApplicationCommandOptionType,
  type ChatInputCommandInteraction,
  ChannelType,
  type Client,
  Events,
  type GuildMember,
} from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  cleanupSessionFolder,
  notifyTranscribeWebhook,
  postprocessSession,
} from '../postprocess.js';
import { VoiceRecorder } from '../recorder.js';
import { RecordingSession } from '../session.js';
import { shortHash } from '../util/hash.js';

const activeSessions = new Map<string, { recorder: VoiceRecorder; session: RecordingSession }>();
const recentStops = new Map<string, number>();
const START_COOLDOWN_MS = 5_000;
const RECENT_STOPS_TTL_MS = 60_000;

function pruneRecentStops(): void {
  const cutoff = Date.now() - RECENT_STOPS_TTL_MS;
  for (const [guildId, ts] of recentStops) {
    if (ts < cutoff) recentStops.delete(guildId);
  }
}

/**
 * Stop every active recording, finalize the session, and run postprocess so
 * the on-disk layout matches what the /meeting pipeline expects. Called from
 * the SIGINT/SIGTERM handler so a systemd restart never leaves orphaned half-
 * recordings. The webhook handoff is intentionally skipped here because the
 * receiver may also be going down at the same time; the session folder is
 * complete on disk and can be re-handed-off later via the manual /meeting
 * skill if needed.
 */
export async function finalizeAllActiveSessions(): Promise<void> {
  if (activeSessions.size === 0) return;
  logger.warn({ active: activeSessions.size }, 'shutdown:finalizing active recordings');
  const entries = Array.from(activeSessions.entries());
  activeSessions.clear();
  for (const [guildId, { recorder, session }] of entries) {
    try {
      await recorder.stop();
      await session.finalize('shutdown:auto-finalized');
      await postprocessSession(session);
      logger.info(
        { guildId, sessionId: shortHash(session.id), folder: session.folder },
        'shutdown:session-finalized',
      );
    } catch (err) {
      logger.error(
        { err, guildId, sessionId: shortHash(session.id) },
        'shutdown:finalize failed',
      );
    }
  }
}

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

/**
 * Fail-closed authorization. Empty allowlist = no one. The deployer MUST
 * populate DISCORD_ADMIN_USER_IDS before recording works. This is a privacy
 * decision: an unconfigured bot must not record voice.
 */
function isAuthorized(member: GuildMember | null): boolean {
  if (config.discord.adminUserIds.length === 0) return false;
  if (!member) return false;
  return config.discord.adminUserIds.includes(member.id);
}

async function setRecordingPresence(client: Client, channelName: string | null): Promise<void> {
  try {
    if (channelName) {
      client.user?.setPresence({
        activities: [{ name: `Recording #${channelName}`, type: ActivityType.Watching }],
        status: 'online',
      });
    } else {
      client.user?.setPresence({ activities: [], status: 'online' });
    }
  } catch (err) {
    logger.warn({ err }, 'discord:presence update failed');
  }
}

async function postChannelConsentBanner(
  interaction: ChatInputCommandInteraction,
  channelName: string,
  starterMention: string,
): Promise<void> {
  // Public message to the *text* channel where the slash command was used so
  // everyone (including people who join the voice channel later) can scroll
  // back and see that recording is active. Best-effort.
  try {
    const channel = interaction.channel;
    if (channel && 'send' in channel && channel.type !== ChannelType.GuildStageVoice) {
      await channel.send(
        `**Recording active** in voice channel **${channelName}** - started by ${starterMention}. ` +
          'All participants are being recorded for meeting capture. ' +
          'Leave the voice channel if you do not consent. Run `/scribe stop` to end.',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'discord:consent-banner post failed');
  }
}

async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !interaction.member) {
    await interaction.reply({ content: 'ZAOscribe only works inside a server.', ephemeral: true });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!isAuthorized(member)) {
    await interaction.reply({
      content:
        config.discord.adminUserIds.length === 0
          ? 'ZAOscribe has no admins configured. The deployer must set `DISCORD_ADMIN_USER_IDS` before recording is allowed.'
          : 'You are not authorized to start ZAOscribe.',
      ephemeral: true,
    });
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

  pruneRecentStops();
  const lastStop = recentStops.get(interaction.guild.id);
  if (lastStop && Date.now() - lastStop < START_COOLDOWN_MS) {
    const wait = Math.ceil((START_COOLDOWN_MS - (Date.now() - lastStop)) / 1000);
    await interaction.reply({
      content: `Cooldown active. Try again in ${wait}s.`,
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

  await setRecordingPresence(interaction.client, channel.name);
  await postChannelConsentBanner(interaction, channel.name, `<@${interaction.user.id}>`);

  await interaction.editReply(
    `ZAOscribe is recording **${channel.name}**.\n` +
      `Session: \`${session.id}\`. Run \`/scribe stop\` when done.`,
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
  recentStops.set(interaction.guild.id, Date.now());

  const { stems } = await recorder.stop();
  await session.finalize(notes);
  await setRecordingPresence(interaction.client, null);

  await interaction.editReply(
    `Recording stopped. ${stems.length} stem(s) captured. Postprocessing...`,
  );

  let mixPath = '';
  let stemWavs: string[] = [];
  let failedStems = 0;
  let postprocessOk = true;
  try {
    const post = await postprocessSession(session);
    mixPath = post.mixPath;
    stemWavs = post.stemWavs;
    failedStems = post.failedStems;
  } catch (err) {
    postprocessOk = false;
    logger.error(
      { err, sessionId: shortHash(session.id) },
      'discord:postprocess threw unexpectedly',
    );
  }

  // If postprocess failed AND we have no usable stems, scrub the folder so
  // disk doesn't fill with broken sessions.
  if (!postprocessOk && stemWavs.length === 0) {
    await cleanupSessionFolder(session);
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
          { userId: p.userId, usernameHash: shortHash(p.username) },
        ]),
      ),
      startedAt: session.meta.startedAt,
      ...(session.meta.endedAt !== undefined ? { endedAt: session.meta.endedAt } : {}),
      ...(session.meta.channelName !== undefined ? { channelName: session.meta.channelName } : {}),
    },
  );

  const summaryLines = [
    `**Session** \`${session.id}\``,
    `**Stems** ${stems.length} captured${failedStems > 0 ? `, ${failedStems} failed encode` : ''} - mixed to \`${mixPath || 'n/a'}\``,
    `**Folder** \`${session.folder}\``,
    `**Duration** ${session.meta.durationMs ? `${Math.round(session.meta.durationMs / 1000)}s` : 'n/a'}`,
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

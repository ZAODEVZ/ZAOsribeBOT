import {
  ApplicationCommandOptionType,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { execCapped } from '../util/exec.js';

export const VPS_SLASH_COMMAND = {
  name: 'vps',
  description: 'Manage @ZAOcoworkingBot + sibling systemd services on this host',
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'status',
      description: 'systemctl is-active + last 5 log lines for an allowed service',
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'service',
          description: 'Service unit name (must be in VPS_ALLOWED_SERVICES)',
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'logs',
      description: 'Last N log lines for an allowed service',
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'service',
          description: 'Service unit name (must be in VPS_ALLOWED_SERVICES)',
          required: true,
        },
        {
          type: ApplicationCommandOptionType.Integer,
          name: 'lines',
          description: 'Lines of journal output to return (1-50, default 20)',
          required: false,
          min_value: 1,
          max_value: 50,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'restart',
      description: 'Restart an allowed service. Restricted to VPS_RESTART_USER_IDS.',
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'service',
          description: 'Service unit name (must be in VPS_ALLOWED_SERVICES)',
          required: true,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: 'reason',
          description: 'Why - logged for ops audit trail',
          required: true,
        },
      ],
    },
  ],
} as const;

function serviceAllowed(service: string): boolean {
  return config.vps.allowedServices.includes(service);
}

function systemctlArgs(...rest: string[]): string[] {
  return config.vps.systemctlUserScope ? ['--user', ...rest] : rest;
}

function journalctlArgs(...rest: string[]): string[] {
  return config.vps.systemctlUserScope ? ['--user', ...rest] : rest;
}

async function replyMono(
  interaction: ChatInputCommandInteraction,
  title: string,
  body: string,
): Promise<void> {
  const trimmed = body.length > 1800 ? `${body.slice(-1800)}\n[...truncated]` : body;
  const block = '```';
  await interaction.editReply(`**${title}**\n${block}\n${trimmed}\n${block}`);
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const service = interaction.options.getString('service', true);
  if (!serviceAllowed(service)) {
    await interaction.reply({
      content: `Service \`${service}\` is not in VPS_ALLOWED_SERVICES.`,
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const active = await execCapped('systemctl', systemctlArgs('is-active', service));
  const status = await execCapped('systemctl', systemctlArgs('status', service, '--no-pager', '-n', '5'));
  const body = `is-active: ${active.stdout.trim() || active.stderr.trim() || 'unknown'}\n\n${status.stdout}${status.stderr ? `\n[stderr]\n${status.stderr}` : ''}`;
  await replyMono(interaction, `systemctl status ${service}`, body);
}

async function handleLogs(interaction: ChatInputCommandInteraction): Promise<void> {
  const service = interaction.options.getString('service', true);
  const lines = interaction.options.getInteger('lines') ?? 20;
  if (!serviceAllowed(service)) {
    await interaction.reply({
      content: `Service \`${service}\` is not in VPS_ALLOWED_SERVICES.`,
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const out = await execCapped(
    'journalctl',
    journalctlArgs('-u', service, '-n', String(lines), '--no-pager', '--output=short-iso'),
    { timeoutMs: 15_000, maxBytes: 16 * 1024 },
  );
  await replyMono(
    interaction,
    `journalctl ${service} (last ${lines})`,
    out.stdout || out.stderr || '[empty]',
  );
}

async function handleRestart(interaction: ChatInputCommandInteraction): Promise<void> {
  const service = interaction.options.getString('service', true);
  const reason = interaction.options.getString('reason', true);
  if (!serviceAllowed(service)) {
    await interaction.reply({
      content: `Service \`${service}\` is not in VPS_ALLOWED_SERVICES.`,
      ephemeral: true,
    });
    return;
  }
  if (
    config.vps.restartUserIds.length === 0 ||
    !config.vps.restartUserIds.includes(interaction.user.id)
  ) {
    await interaction.reply({
      content: 'You are not authorized to restart services. Add your user ID to VPS_RESTART_USER_IDS.',
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply();
  logger.warn(
    { service, reason, userId: interaction.user.id },
    'vps:restart-requested',
  );
  const out = await execCapped('systemctl', systemctlArgs('restart', service), {
    timeoutMs: 30_000,
  });
  const active = await execCapped('systemctl', systemctlArgs('is-active', service));
  const body = `restart exit=${out.code}${out.timedOut ? ' (timed out)' : ''}\nis-active: ${active.stdout.trim() || active.stderr.trim()}\n\n${out.stderr || out.stdout || '[no output]'}`;
  await replyMono(interaction, `systemctl restart ${service} (reason: ${reason})`, body);
}

export async function handleVpsCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (config.vps.allowedServices.length === 0) {
    await interaction.reply({
      content:
        '/vps is disabled (VPS_ALLOWED_SERVICES is empty). Set the env var to a comma-separated list of unit names.',
      ephemeral: true,
    });
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub === 'status') await handleStatus(interaction);
  else if (sub === 'logs') await handleLogs(interaction);
  else if (sub === 'restart') await handleRestart(interaction);
}

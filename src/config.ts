import 'dotenv/config';
import { resolve } from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function csv(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  discord: {
    token: required('DISCORD_BOT_TOKEN'),
    appId: required('DISCORD_APP_ID'),
    guildId: optional('DISCORD_GUILD_ID'),
    adminUserIds: csv('DISCORD_ADMIN_USER_IDS'),
  },
  telegram: {
    token: optional('TELEGRAM_BOT_TOKEN'),
    allowedChatIds: csv('TELEGRAM_ALLOWED_CHAT_IDS'),
  },
  storage: {
    recordingsDir: resolve(process.cwd(), optional('RECORDINGS_DIR', './recordings')),
    publicBaseUrl: optional('PUBLIC_BASE_URL'),
    // Hard cap on total recordings/ bytes; /scribe start refuses past this.
    maxBytes: Number(optional('MAX_RECORDINGS_BYTES', String(20 * 1024 * 1024 * 1024))),
  },
  transcribe: {
    webhookUrl: optional('TRANSCRIBE_WEBHOOK_URL'),
    webhookSecret: optional('TRANSCRIBE_WEBHOOK_SECRET'),
    openaiApiKey: optional('OPENAI_API_KEY'),
    maxMonthlyUsd: Number(optional('MAX_MONTHLY_TRANSCRIBE_USD', '20')),
  },
  vps: {
    // Service unit names that /vps may target (allow-list). Empty = /vps disabled.
    allowedServices: csv('VPS_ALLOWED_SERVICES'),
    // Subset of users who may run /vps restart (not just status/logs).
    restartUserIds: csv('VPS_RESTART_USER_IDS'),
    // systemctl --user vs system. Cowork bot uses --user.
    systemctlUserScope: optional('VPS_SYSTEMCTL_USER_SCOPE', 'true').toLowerCase() === 'true',
  },
  log: {
    level: optional('LOG_LEVEL', 'info'),
    env: optional('NODE_ENV', 'production'),
  },
} as const;

export type AppConfig = typeof config;

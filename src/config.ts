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
  },
  transcribe: {
    webhookUrl: optional('TRANSCRIBE_WEBHOOK_URL'),
    webhookSecret: optional('TRANSCRIBE_WEBHOOK_SECRET'),
    openaiApiKey: optional('OPENAI_API_KEY'),
    maxMonthlyUsd: Number(optional('MAX_MONTHLY_TRANSCRIBE_USD', '20')),
  },
  log: {
    level: optional('LOG_LEVEL', 'info'),
    env: optional('NODE_ENV', 'production'),
  },
} as const;

export type AppConfig = typeof config;

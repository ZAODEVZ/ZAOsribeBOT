import { randomUUID } from 'node:crypto';
import { access, constants, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { startDiscordClient } from './discord/client.js';
import { logger } from './logger.js';

async function validateWriteAccess(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await access(dir, constants.W_OK);
  // Round-trip a probe file so we catch read-only mounts + permission edge
  // cases at boot instead of mid-recording.
  const probe = join(dir, `.write-probe-${randomUUID()}`);
  try {
    await writeFile(probe, 'ok');
  } finally {
    await unlink(probe).catch(() => {});
  }
}

function validateWebhookUrl(): void {
  const url = config.transcribe.webhookUrl;
  if (!url) {
    logger.warn('boot:no-webhook configured - /scribe stop will print summary but not hand off');
    return;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && config.log.env === 'production') {
      logger.error(
        { protocol: parsed.protocol },
        'boot:webhook URL is not HTTPS in production - PII (usernames in payload) sent cleartext. Refusing to boot.',
      );
      process.exit(2);
    }
    if (parsed.protocol !== 'https:') {
      logger.warn(
        { protocol: parsed.protocol },
        'boot:webhook URL is not HTTPS - acceptable in dev but never deploy this',
      );
    }
    if (!config.transcribe.webhookSecret) {
      logger.warn('boot:no webhook secret set - payloads will not be HMAC-signed');
    }
  } catch (err) {
    logger.error({ err, url }, 'boot:webhook URL invalid');
    process.exit(2);
  }
}

function validateDiscordConfig(): void {
  if (config.discord.adminUserIds.length === 0) {
    logger.warn(
      'boot:DISCORD_ADMIN_USER_IDS is empty - /scribe start will refuse to record for any user. ' +
        'Set the env var to a comma-separated list of allowed Discord user IDs.',
    );
  }
}

async function main(): Promise<void> {
  await validateWriteAccess(config.storage.recordingsDir);
  logger.info({ recordingsDir: config.storage.recordingsDir }, 'boot:storage-ready');

  validateWebhookUrl();
  validateDiscordConfig();

  const client = await startDiscordClient();
  logger.info('boot:discord-up');

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, 'shutdown:received');
    try {
      await client.destroy();
    } catch (err) {
      logger.error({ err }, 'shutdown:client destroy failed');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'boot:fatal');
  process.exit(1);
});

import { randomUUID } from 'node:crypto';
import { access, constants, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { startDiscordClient } from './discord/client.js';
import { finalizeAllActiveSessions } from './discord/commands.js';
import { logger } from './logger.js';

class BootError extends Error {
  constructor(message: string, public readonly exitCode = 2) {
    super(message);
    this.name = 'BootError';
  }
}

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
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new BootError(
      `webhook URL invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed.protocol !== 'https:' && config.log.env === 'production') {
    throw new BootError(
      `webhook URL is not HTTPS in production (got ${parsed.protocol}) - PII would be sent cleartext`,
    );
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

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn({ signal }, 'shutdown:received');

    // Race the finalize work against a hard cap so systemd's TimeoutStopSec
    // never has to SIGKILL us mid-flush. The cap covers all active sessions
    // collectively, not per-session.
    const FINALIZE_DEADLINE_MS = 30_000;
    await Promise.race([
      finalizeAllActiveSessions(),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          logger.error({ deadlineMs: FINALIZE_DEADLINE_MS }, 'shutdown:finalize deadline exceeded');
          resolve();
        }, FINALIZE_DEADLINE_MS),
      ),
    ]);

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
  if (err instanceof BootError) {
    logger.fatal({ msg: err.message }, 'boot:refused');
    process.exit(err.exitCode);
  }
  logger.fatal({ err }, 'boot:fatal');
  process.exit(1);
});

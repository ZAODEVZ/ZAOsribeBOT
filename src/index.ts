import { mkdir } from 'node:fs/promises';
import { config } from './config.js';
import { startDiscordClient } from './discord/client.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  await mkdir(config.storage.recordingsDir, { recursive: true });
  logger.info({ recordingsDir: config.storage.recordingsDir }, 'boot:storage-ready');

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

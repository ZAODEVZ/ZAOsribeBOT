import { REST, Routes } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { SLASH_COMMANDS } from '../discord/commands.js';

async function main(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  const body = SLASH_COMMANDS.map((cmd) => ({ ...cmd }));

  if (config.discord.guildId) {
    logger.info({ guildId: config.discord.guildId }, 'commands:registering (guild)');
    await rest.put(
      Routes.applicationGuildCommands(config.discord.appId, config.discord.guildId),
      { body },
    );
    logger.info('commands:registered (guild) - takes effect immediately');
  } else {
    logger.info('commands:registering (global)');
    await rest.put(Routes.applicationCommands(config.discord.appId), { body });
    logger.info('commands:registered (global) - propagation can take up to 1 hour');
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'commands:register failed');
  process.exit(1);
});

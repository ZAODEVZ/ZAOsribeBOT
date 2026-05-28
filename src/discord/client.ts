import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { registerCommandHandlers } from './commands.js';

export async function startDiscordClient(): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    logger.info({ tag: c.user.tag }, 'discord:ready');
  });

  registerCommandHandlers(client);

  await client.login(config.discord.token);
  return client;
}

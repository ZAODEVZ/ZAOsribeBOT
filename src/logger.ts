import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.log.level,
  ...(config.log.env === 'production'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }),
  base: { app: 'zaoscribe' },
});

export type Logger = typeof logger;

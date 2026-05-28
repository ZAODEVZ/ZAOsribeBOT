import { createWriteStream, type WriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import {
  type AudioReceiveStream,
  EndBehaviorType,
  joinVoiceChannel,
  type VoiceConnection,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import prism from 'prism-media';
import { logger } from './logger.js';
import type { RecordingSession } from './session.js';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;

interface ActiveUserStream {
  receiveStream: AudioReceiveStream;
  decoder: prism.opus.Decoder;
  fileStream: WriteStream;
  closed: boolean;
}

export class VoiceRecorder {
  private connection: VoiceConnection | null = null;
  private userStreams = new Map<string, ActiveUserStream>();
  private channelName: string;

  constructor(
    private readonly channel: VoiceBasedChannel,
    private readonly session: RecordingSession,
  ) {
    this.channelName = channel.name;
  }

  async start(): Promise<void> {
    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    const receiver = this.connection.receiver;
    receiver.speaking.on('start', (userId) => {
      this.handleSpeakingStart(userId).catch((err) => {
        logger.error({ err, userId }, 'recorder:speaking-start error');
      });
    });

    logger.info(
      { sessionId: this.session.id, channelId: this.channel.id, channelName: this.channelName },
      'recorder:start',
    );
  }

  private async handleSpeakingStart(userId: string): Promise<void> {
    if (this.userStreams.has(userId)) return;
    if (!this.connection) return;

    const member = await this.channel.guild.members.fetch(userId).catch(() => null);
    const username = member?.user.username ?? 'unknown';
    const displayName = member?.displayName ?? username;
    const participant = await this.session.addParticipant({ userId, username, displayName });

    const receiveStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    const decoder = new prism.opus.Decoder({
      rate: SAMPLE_RATE,
      channels: CHANNELS,
      frameSize: 960,
    });
    const pcmPath = `${this.session.folder}/${participant.stemFilename}`;
    const fileStream = createWriteStream(pcmPath, { flags: 'a' });

    const entry: ActiveUserStream = { receiveStream, decoder, fileStream, closed: false };
    this.userStreams.set(userId, entry);

    pipeline(receiveStream, decoder, fileStream).catch((err) => {
      if (entry.closed) return;
      logger.error({ err, userId }, 'recorder:pipeline error');
    });

    logger.info({ userId, username, pcmPath }, 'recorder:user-stream-started');
  }

  async stop(): Promise<{ stems: Array<{ userId: string; pcmPath: string; bytes: number }> }> {
    const stems: Array<{ userId: string; pcmPath: string; bytes: number }> = [];

    for (const [userId, entry] of this.userStreams.entries()) {
      entry.closed = true;
      try {
        entry.receiveStream.destroy();
      } catch (err) {
        logger.warn({ err, userId }, 'recorder:receiveStream destroy failed');
      }
      try {
        entry.decoder.end();
      } catch (err) {
        logger.warn({ err, userId }, 'recorder:decoder end failed');
      }
      await new Promise<void>((resolve) => {
        entry.fileStream.end(() => resolve());
      });
      const pcmPath = `${this.session.folder}/${this.session.meta.participants[userId]?.stemFilename ?? ''}`;
      try {
        const s = await stat(pcmPath);
        stems.push({ userId, pcmPath, bytes: s.size });
      } catch {
        // file missing - skip
      }
      this.session.markParticipantLeft(userId);
    }

    this.userStreams.clear();

    if (this.connection) {
      try {
        this.connection.destroy();
      } catch (err) {
        logger.warn({ err }, 'recorder:connection destroy failed');
      }
      this.connection = null;
    }

    logger.info(
      { sessionId: this.session.id, stems: stems.length, totalBytes: stems.reduce((a, b) => a + b.bytes, 0) },
      'recorder:stop',
    );

    return { stems };
  }
}

export const RECORDER_AUDIO_FORMAT = {
  sampleRate: SAMPLE_RATE,
  channels: CHANNELS,
  bitDepth: 16,
  encoding: 'pcm_s16le' as const,
};

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

export interface SessionParticipant {
  userId: string;
  username: string;
  displayName: string;
  joinedAt: string;
  leftAt?: string;
  stemFilename: string;
}

export interface SessionMetadata {
  id: string;
  source: 'discord' | 'telegram' | 'web';
  guildId?: string;
  channelId?: string;
  channelName?: string;
  startedBy: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  participants: Record<string, SessionParticipant>;
  folder: string;
  notes?: string;
}

export class RecordingSession {
  readonly id: string;
  readonly folder: string;
  readonly meta: SessionMetadata;
  private metaPath: string;

  constructor(init: {
    source: SessionMetadata['source'];
    startedBy: string;
    guildId?: string;
    channelId?: string;
    channelName?: string;
  }) {
    this.id = randomUUID();
    this.folder = join(config.storage.recordingsDir, this.id);
    this.metaPath = join(this.folder, 'meta.json');
    this.meta = {
      id: this.id,
      source: init.source,
      startedBy: init.startedBy,
      startedAt: new Date().toISOString(),
      participants: {},
      folder: this.folder,
      ...(init.guildId !== undefined ? { guildId: init.guildId } : {}),
      ...(init.channelId !== undefined ? { channelId: init.channelId } : {}),
      ...(init.channelName !== undefined ? { channelName: init.channelName } : {}),
    };
  }

  async init(): Promise<void> {
    await mkdir(this.folder, { recursive: true });
    await this.persist();
    logger.info({ id: this.id, folder: this.folder }, 'session:init');
  }

  async addParticipant(p: Omit<SessionParticipant, 'joinedAt' | 'stemFilename'>): Promise<SessionParticipant> {
    const existing = this.meta.participants[p.userId];
    if (existing) return existing;
    const index = Object.keys(this.meta.participants).length + 1;
    const safeName = p.username.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) || 'user';
    const stemFilename = `${index}-${safeName}.pcm`;
    const participant: SessionParticipant = {
      ...p,
      joinedAt: new Date().toISOString(),
      stemFilename,
    };
    this.meta.participants[p.userId] = participant;
    await this.persist();
    logger.info({ id: this.id, userId: p.userId, stemFilename }, 'session:participant-added');
    return participant;
  }

  markParticipantLeft(userId: string): void {
    const p = this.meta.participants[userId];
    if (p) p.leftAt = new Date().toISOString();
  }

  async finalize(notes?: string): Promise<void> {
    this.meta.endedAt = new Date().toISOString();
    this.meta.durationMs =
      new Date(this.meta.endedAt).getTime() - new Date(this.meta.startedAt).getTime();
    if (notes) this.meta.notes = notes;
    await this.persist();
    logger.info({ id: this.id, durationMs: this.meta.durationMs }, 'session:finalize');
  }

  stemPath(userId: string): string | null {
    const p = this.meta.participants[userId];
    if (!p) return null;
    return join(this.folder, p.stemFilename);
  }

  participantCount(): number {
    return Object.keys(this.meta.participants).length;
  }

  private async persist(): Promise<void> {
    await writeFile(this.metaPath, JSON.stringify(this.meta, null, 2));
  }
}

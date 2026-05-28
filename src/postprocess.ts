import { spawn } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger.js';
import { RECORDER_AUDIO_FORMAT } from './recorder.js';
import type { RecordingSession } from './session.js';
import { hmacSign, shortHash } from './util/hash.js';

/**
 * Convert raw PCM stem to a WAV file. Craig-style per-user audio: one WAV per
 * speaker so downstream diarization is free (the file IS the speaker).
 */
function pcmToWav(pcmPath: string, wavPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f',
      's16le',
      '-ar',
      String(RECORDER_AUDIO_FORMAT.sampleRate),
      '-ac',
      String(RECORDER_AUDIO_FORMAT.channels),
      '-i',
      pcmPath,
      '-c:a',
      'pcm_s16le',
      wavPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg pcm2wav exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Downmix N per-user WAVs to a single 16k mono WAV with loudness normalization.
 * Matches the layout the /meeting skill consumes (one mix wav, ready for whisper).
 */
function mixStems(stemWavs: string[], outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stemWavs.length === 0) {
      reject(new Error('no stems to mix'));
      return;
    }
    const inputs = stemWavs.flatMap((p) => ['-i', p]);
    const inputLabels = stemWavs.map((_, i) => `[${i}:a]`).join('');
    const filter = `${inputLabels}amix=inputs=${stemWavs.length}:duration=longest:normalize=0,loudnorm=I=-16:TP=-1.5[a]`;
    const args = [
      '-y',
      ...inputs,
      '-filter_complex',
      filter,
      '-map',
      '[a]',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      outPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg mix exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function fileSizeOr(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return -1;
  }
}

export interface PostprocessResult {
  stemWavs: string[];
  mixPath: string;
  failedStems: number;
}

export async function postprocessSession(session: RecordingSession): Promise<PostprocessResult> {
  const stemWavs: string[] = [];
  let failedStems = 0;

  for (const participant of Object.values(session.meta.participants)) {
    const pcmPath = join(session.folder, participant.stemFilename);
    const pcmSize = await fileSizeOr(pcmPath);
    if (pcmSize <= 0) {
      logger.warn(
        {
          sessionId: shortHash(session.id),
          userHash: shortHash(participant.userId),
          pcmPath,
          pcmSize,
        },
        'postprocess:pcm-missing-or-empty',
      );
      failedStems += 1;
      continue;
    }

    const wavName = participant.stemFilename.replace(/\.pcm$/, '.wav');
    const wavPath = join(session.folder, wavName);
    try {
      await pcmToWav(pcmPath, wavPath);
      const wavSize = await fileSizeOr(wavPath);
      if (wavSize <= 0) {
        logger.warn(
          { sessionId: shortHash(session.id), wavPath },
          'postprocess:wav-empty-after-encode',
        );
        failedStems += 1;
        continue;
      }
      stemWavs.push(wavPath);
      participant.stemFilename = wavName;
    } catch (err) {
      logger.error(
        {
          err,
          sessionId: shortHash(session.id),
          userHash: shortHash(participant.userId),
          pcmPath,
        },
        'postprocess:pcm2wav failed',
      );
      failedStems += 1;
    }
  }

  // Re-persist meta.json so the on-disk record matches the renamed wavs. A
  // crash after this point still recovers; before this point would have left
  // stale .pcm references.
  await session.persist();

  const mixPath = join(session.folder, 'mix.wav');
  if (stemWavs.length > 0) {
    try {
      await mixStems(stemWavs, mixPath);
      const mixSize = await fileSizeOr(mixPath);
      if (mixSize <= 0) {
        logger.warn({ sessionId: shortHash(session.id), mixPath }, 'postprocess:mix-empty');
      }
    } catch (err) {
      logger.error({ err, sessionId: shortHash(session.id) }, 'postprocess:mix failed');
    }
  } else {
    logger.warn({ sessionId: shortHash(session.id) }, 'postprocess:no stems to mix');
  }

  logger.info(
    { sessionId: shortHash(session.id), stems: stemWavs.length, failedStems, mixPath },
    'postprocess:done',
  );
  return { stemWavs, mixPath, failedStems };
}

export async function cleanupSessionFolder(session: RecordingSession): Promise<void> {
  try {
    await rm(session.folder, { recursive: true, force: true });
    logger.info({ sessionId: shortHash(session.id) }, 'postprocess:cleanup ok');
  } catch (err) {
    logger.error({ err, sessionId: shortHash(session.id) }, 'postprocess:cleanup failed');
  }
}

export interface WebhookPayload {
  sessionId: string;
  source: string;
  folder: string;
  mixPath: string;
  stemWavs: string[];
  participants: Record<string, { userId: string; usernameHash: string }>;
  startedAt: string;
  endedAt?: string;
  channelName?: string;
}

/**
 * POST the session handoff to the configured webhook (typically Zaal's mac
 * running the /meeting pipeline). Signature scheme matches GitHub-style HMAC:
 *
 *   x-zaoscribe-timestamp: <epoch ms>
 *   x-zaoscribe-signature: sha256=<hmac-sha256(secret, `${ts}.${body}`)>
 *
 * Receiver verifies timestamp recency (<= 5min) + constant-time compares the
 * signature before processing. Best-effort; never throws.
 */
export async function notifyTranscribeWebhook(
  webhookUrl: string,
  webhookSecret: string,
  payload: WebhookPayload,
): Promise<{ ok: boolean; status?: number; body?: string }> {
  if (!webhookUrl) return { ok: false, status: 0, body: 'no webhook configured' };

  const rawBody = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (webhookSecret) {
    const timestamp = Date.now().toString();
    headers['x-zaoscribe-timestamp'] = timestamp;
    headers['x-zaoscribe-signature'] = `sha256=${hmacSign(webhookSecret, timestamp, rawBody)}`;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 500) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, sessionId: shortHash(payload.sessionId) }, 'postprocess:webhook failed');
    return { ok: false, body: msg };
  }
}

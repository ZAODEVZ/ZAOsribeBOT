import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { logger } from './logger.js';
import { RECORDER_AUDIO_FORMAT } from './recorder.js';
import type { RecordingSession } from './session.js';

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
    const filter =
      stemWavs.map((_, i) => `[${i}:a]`).join('') +
      `amix=inputs=${stemWavs.length}:duration=longest:normalize=0,loudnorm=I=-16:TP=-1.5[a]`;
    const args = ['-y', ...inputs, '-filter_complex', filter, '-map', '[a]', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outPath];
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

export interface PostprocessResult {
  stemWavs: string[];
  mixPath: string;
}

export async function postprocessSession(session: RecordingSession): Promise<PostprocessResult> {
  const stemWavs: string[] = [];

  for (const participant of Object.values(session.meta.participants)) {
    const pcmPath = join(session.folder, participant.stemFilename);
    const wavName = participant.stemFilename.replace(/\.pcm$/, '.wav');
    const wavPath = join(session.folder, wavName);
    try {
      await pcmToWav(pcmPath, wavPath);
      stemWavs.push(wavPath);
      // Keep the pcm too (cheap insurance); rename participant ref to wav.
      participant.stemFilename = wavName;
    } catch (err) {
      logger.error({ err, userId: participant.userId, pcmPath }, 'postprocess:pcm2wav failed');
    }
  }

  const mixPath = join(session.folder, 'mix.wav');
  if (stemWavs.length > 0) {
    try {
      await mixStems(stemWavs, mixPath);
    } catch (err) {
      logger.error({ err }, 'postprocess:mix failed');
    }
  }

  logger.info({ sessionId: session.id, stems: stemWavs.length, mixPath }, 'postprocess:done');
  return { stemWavs, mixPath };
}

export async function notifyTranscribeWebhook(
  webhookUrl: string,
  webhookSecret: string,
  payload: {
    sessionId: string;
    source: string;
    folder: string;
    mixPath: string;
    stemWavs: string[];
    participants: Record<string, { userId: string; username: string; displayName: string }>;
    startedAt: string;
    endedAt?: string;
    channelName?: string;
  },
): Promise<{ ok: boolean; status?: number; body?: string }> {
  if (!webhookUrl) return { ok: false, status: 0, body: 'no webhook configured' };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(webhookSecret ? { authorization: `Bearer ${webhookSecret}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 500) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'postprocess:webhook failed');
    return { ok: false, body: msg };
  }
}

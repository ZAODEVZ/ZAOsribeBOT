import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';

async function folderSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    try {
      const s = await stat(p);
      if (s.isDirectory()) total += await folderSizeBytes(p);
      else total += s.size;
    } catch {
      // entry vanished between readdir + stat - skip
    }
  }
  return total;
}

export interface QuotaCheck {
  bytesUsed: number;
  bytesAvailable: number;
  capBytes: number;
  overCap: boolean;
}

/**
 * Check the total bytes used under RECORDINGS_DIR against MAX_RECORDINGS_BYTES.
 * Cheap to call (one readdir tree per session start). Returns overCap=true if
 * we should refuse a new recording.
 */
export async function checkRecordingsQuota(): Promise<QuotaCheck> {
  const bytesUsed = await folderSizeBytes(config.storage.recordingsDir);
  const capBytes = config.storage.maxBytes;
  return {
    bytesUsed,
    bytesAvailable: Math.max(0, capBytes - bytesUsed),
    capBytes,
    overCap: bytesUsed >= capBytes,
  };
}

export function humanBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

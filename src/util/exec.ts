import { spawn } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

/**
 * Run a shell command with no shell expansion (no shell:true), capped output
 * size + a hard timeout. Used by the /vps command to wrap systemctl /
 * journalctl on the VPS where the bot is running.
 */
export async function execCapped(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 64 * 1024;

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let truncated = false;

    const onData = (target: 'out' | 'err') => (chunk: Buffer) => {
      const s = chunk.toString();
      if (target === 'out') {
        if (stdout.length + s.length > maxBytes) {
          stdout += s.slice(0, Math.max(0, maxBytes - stdout.length));
          truncated = true;
        } else {
          stdout += s;
        }
      } else {
        if (stderr.length + s.length > maxBytes) {
          stderr += s.slice(0, Math.max(0, maxBytes - stderr.length));
          truncated = true;
        } else {
          stderr += s;
        }
      }
      if (truncated) {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    };
    proc.stdout.on('data', onData('out'));
    proc.stderr.on('data', onData('err'));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1, timedOut });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + `\n[spawn error: ${err.message}]`, code: -1, timedOut });
    });
  });
}

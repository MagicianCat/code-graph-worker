import { spawn } from 'node:child_process';
import { WorkerError } from './errors.js';

export function runProcess(binary, args, { cwd, env, timeoutMs = 10_000, allowExitCodes = [0], maxOutputBytes = 8_388_608 } = {}) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Process arguments must be a string array');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG ?? 'C.UTF-8', ...env },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killTree = (signal) => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    let outputBytes = 0;
    const append = (target, chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        killTree('SIGTERM');
        return target;
      }
      return target + chunk;
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new WorkerError('ENGINE_UNAVAILABLE', `Unable to execute ${binary}`, {
        retryable: true,
        details: { cause: error.message },
      }));
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new WorkerError('QUERY_TIMEOUT', `${binary} timed out`, {
          status: 408,
          retryable: true,
          details: { timeoutMs },
        }));
      } else if (outputBytes > maxOutputBytes) {
        reject(new WorkerError('ENGINE_UNAVAILABLE', `${binary} exceeded output limit`, { retryable: false, details: { maxOutputBytes } }));
      } else if (!allowExitCodes.includes(exitCode)) {
        reject(new WorkerError('ENGINE_ANALYZE_FAILED', `${binary} exited with code ${exitCode}`, {
          retryable: true,
          details: { exitCode, signal, stderr: stderr.slice(-4_000) },
        }));
      } else {
        resolve({ stdout, stderr, exitCode });
      }
    });
  });
}

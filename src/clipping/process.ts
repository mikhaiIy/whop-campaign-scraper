import { execFile } from 'node:child_process';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export type ProcessRunner = (command: string, args: string[], timeoutMs: number) => Promise<ProcessResult>;

export const defaultProcessRunner: ProcessRunner = (command, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, cwd: process.cwd() }, (error, stdout, stderr) => {
    if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      reject(new Error(`Command "${command}" was not found on PATH.`));
      return;
    }
    resolve({
      stdout: String(stdout),
      stderr: String(stderr),
      code: error ? ((error as { code?: number }).code ?? 1) : 0,
      timedOut: Boolean(error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed),
    });
  });
});

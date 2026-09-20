import { execFile } from 'node:child_process';

export const DEFAULT_LOCAL_MODEL = 'opencode-go/deepseek-v4.1-flash';

export interface LlmResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export type LlmRunner = (command: string, args: string[], input: string, timeoutMs: number) => Promise<LlmResult>;

export interface TextLlm {
  readonly id: string;
  readonly model: string | null;
  complete(prompt: string, options?: { system?: string }): Promise<string>;
}

export const defaultLlmRunner: LlmRunner = (command, args, input, timeoutMs) => new Promise((resolve, reject) => {
  const child = execFile(command, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, cwd: process.cwd() }, (error, stdout, stderr) => {
    const timedOut = Boolean(error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed);
    if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      reject(new Error(`LLM command "${command}" was not found on PATH.`));
      return;
    }
    resolve({ stdout: String(stdout), stderr: String(stderr), code: error ? ((error as { code?: number }).code ?? 1) : 0, timedOut });
  });
  child.stdin?.end(input);
});

export interface OpenCodeLlmOptions {
  command?: string;
  model?: string;
  timeoutMs?: number;
  runner?: LlmRunner;
  extraArgs?: string[];
}

export class OpenCodeCliLlm implements TextLlm {
  readonly id: string;
  readonly model: string;
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly runner: LlmRunner;
  private readonly extraArgs: string[];

  constructor(options: OpenCodeLlmOptions = {}) {
    this.command = options.command ?? 'opencode';
    this.model = options.model ?? DEFAULT_LOCAL_MODEL;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.runner = options.runner ?? defaultLlmRunner;
    this.extraArgs = options.extraArgs ?? [];
    this.id = `opencode-cli:${this.model}`;
  }

  async complete(prompt: string): Promise<string> {
    const args = ['run', '-m', this.model, ...this.extraArgs, prompt];
    const result = await this.runner(this.command, args, '', this.timeoutMs);
    if (result.timedOut) throw new Error(`${this.id} timed out after ${this.timeoutMs}ms`);
    const text = stripAnsi(result.stdout).trim();
    if (!text) throw new Error(`${this.id} produced no output (exit ${result.code}): ${stripAnsi(result.stderr).trim().slice(0, 400) || 'no stderr'}`);
    return text;
  }
}

export type LlmProvider = 'opencode' | 'none';

export function createLlm(provider: LlmProvider | undefined = (process.env.WHOP_LLM as LlmProvider | undefined), options: OpenCodeLlmOptions = {}): TextLlm | null {
  switch (provider ?? 'opencode') {
    case 'opencode': return new OpenCodeCliLlm(options);
    case 'none': return null;
    default: return new OpenCodeCliLlm(options);
  }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const stripAnsi = (text: string): string => text.replace(ANSI, '');

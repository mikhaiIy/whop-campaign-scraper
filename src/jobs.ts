import { randomUUID } from 'node:crypto';

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type JobStage = 'brief' | 'extract' | 'footage' | 'transcribe' | 'moments' | 'clips';

export interface JobLogLine {
  at: string;
  text: string;
}

export interface Job {
  id: string;
  stage: JobStage;
  campaignId: string;
  label: string;
  state: JobState;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  progress: string | null;
  log: JobLogLine[];
  error: string | null;
  result: unknown;
}

export interface JobContext {
  signal: AbortSignal;
  log(text: string): void;
  progress(text: string): void;
}

export type JobBody = (context: JobContext) => Promise<unknown>;

export interface JobRunnerOptions {
  /** How many jobs may run at the same time. */
  concurrency?: number;
  /** How many finished jobs to keep for the history view. */
  historyLimit?: number;
  now?: () => number;
}

const MAX_LOG_LINES = 400;

interface Entry {
  job: Job;
  body: JobBody;
  controller: AbortController;
}

/**
 * Runs pipeline stages in the background so HTTP requests return at once.
 * Jobs are held in memory. A restart loses them, which is correct: a restart
 * also kills the child processes that the jobs supervise.
 */
export class JobRunner {
  private readonly concurrency: number;
  private readonly historyLimit: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly queue: string[] = [];
  private running = 0;

  constructor(options: JobRunnerOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 3);
    this.historyLimit = Math.max(1, options.historyLimit ?? 60);
    this.now = options.now ?? Date.now;
  }

  /** Adds a job to the queue and returns it. The job starts when a slot is free. */
  submit(input: { stage: JobStage; campaignId: string; label: string; body: JobBody }): Job {
    const job: Job = {
      id: randomUUID(),
      stage: input.stage,
      campaignId: input.campaignId,
      label: input.label,
      state: 'queued',
      queuedAt: new Date(this.now()).toISOString(),
      startedAt: null,
      endedAt: null,
      durationMs: null,
      progress: null,
      log: [],
      error: null,
      result: null,
    };
    this.entries.set(job.id, { job, body: input.body, controller: new AbortController() });
    this.queue.push(job.id);
    this.pump();
    return job;
  }

  get(id: string): Job | null {
    return this.entries.get(id)?.job ?? null;
  }

  list(filter: { campaignId?: string } = {}): Job[] {
    const all = [...this.entries.values()].map(entry => entry.job);
    const scoped = filter.campaignId ? all.filter(job => job.campaignId === filter.campaignId) : all;
    return scoped.sort((a, b) => Date.parse(b.queuedAt) - Date.parse(a.queuedAt));
  }

  /** True when this campaign already has a queued or running job for this stage. */
  isBusy(campaignId: string, stage: JobStage): boolean {
    for (const entry of this.entries.values()) {
      const job = entry.job;
      if (job.campaignId !== campaignId) continue;
      if (job.stage !== stage) continue;
      if (job.state === 'queued' || job.state === 'running') return true;
    }
    return false;
  }

  /** Stops a queued or running job. Returns false when the job already finished. */
  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const job = entry.job;
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return false;
    entry.controller.abort();
    if (job.state === 'queued') {
      const index = this.queue.indexOf(id);
      if (index >= 0) this.queue.splice(index, 1);
      this.finish(entry, 'cancelled', null, 'The operator cancelled this job before it started.');
    }
    return true;
  }

  /** Waits for every queued and running job to reach an end state. */
  async drain(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const entry = this.entries.get(id);
      if (!entry) continue;
      void this.start(entry);
    }
  }

  private async start(entry: Entry): Promise<void> {
    const job = entry.job;
    this.running += 1;
    job.state = 'running';
    job.startedAt = new Date(this.now()).toISOString();
    const context: JobContext = {
      signal: entry.controller.signal,
      log: text => {
        job.log.push({ at: new Date(this.now()).toISOString(), text });
        if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
      },
      progress: text => { job.progress = text; },
    };
    try {
      const result = await entry.body(context);
      if (entry.controller.signal.aborted) this.finish(entry, 'cancelled', null, 'The operator cancelled this job.');
      else this.finish(entry, 'done', result, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (entry.controller.signal.aborted) this.finish(entry, 'cancelled', null, 'The operator cancelled this job.');
      else this.finish(entry, 'failed', null, message);
    } finally {
      this.running -= 1;
      this.pump();
    }
  }

  private finish(entry: Entry, state: JobState, result: unknown, error: string | null): void {
    const job = entry.job;
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return;
    job.state = state;
    job.result = result;
    job.error = error;
    job.endedAt = new Date(this.now()).toISOString();
    job.durationMs = job.startedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : null;
    job.progress = null;
    this.trim();
  }

  private trim(): void {
    const finished = [...this.entries.values()]
      .filter(entry => entry.job.state === 'done' || entry.job.state === 'failed' || entry.job.state === 'cancelled')
      .sort((a, b) => Date.parse(a.job.endedAt ?? a.job.queuedAt) - Date.parse(b.job.endedAt ?? b.job.queuedAt));
    const excess = finished.length - this.historyLimit;
    for (let index = 0; index < excess; index += 1) this.entries.delete(finished[index]!.job.id);
  }
}

/** Strips the log and the result so job lists stay small. */
export function jobSummary(job: Job): Omit<Job, 'log' | 'result'> & { logLines: number } {
  const { log, result, ...rest } = job;
  void result;
  return { ...rest, logLines: log.length };
}

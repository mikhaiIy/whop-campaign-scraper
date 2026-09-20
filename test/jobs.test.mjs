import test from 'node:test';
import assert from 'node:assert/strict';
import { JobRunner, jobSummary } from '../dist/jobs.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test('a job runs, records timing and keeps its result', async () => {
  const runner = new JobRunner();
  const job = runner.submit({ stage: 'brief', campaignId: 'c1', label: 'Crawl brief', body: async ctx => { ctx.log('fetched 3 sources'); return { sources: 3 }; } });
  assert.equal(job.state, 'running', 'a free slot starts the job at once');
  await runner.drain();
  const done = runner.get(job.id);
  assert.equal(done.state, 'done');
  assert.deepEqual(done.result, { sources: 3 });
  assert.equal(done.log.length, 1);
  assert.equal(done.log[0].text, 'fetched 3 sources');
  assert.ok(done.durationMs !== null && done.durationMs >= 0);
  assert.equal(done.error, null);
});

test('a failing job is recorded as failed and keeps the message', async () => {
  const runner = new JobRunner();
  const job = runner.submit({ stage: 'extract', campaignId: 'c1', label: 'Extract', body: async () => { throw new Error('the model returned no output'); } });
  await runner.drain();
  const failed = runner.get(job.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'the model returned no output');
  assert.equal(failed.result, null);
});

test('concurrency caps how many jobs run at the same time', async () => {
  const runner = new JobRunner({ concurrency: 2 });
  let active = 0;
  let peak = 0;
  const body = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await settle();
    active -= 1;
    return null;
  };
  for (let i = 0; i < 6; i += 1) runner.submit({ stage: 'clips', campaignId: `c${i}`, label: 'Cut', body });
  await runner.drain();
  assert.equal(peak, 2, `peak concurrency was ${peak}`);
  assert.equal(runner.list().filter(j => j.state === 'done').length, 6);
});

test('isBusy reports a queued or running job for one campaign and stage only', async () => {
  const runner = new JobRunner({ concurrency: 1 });
  runner.submit({ stage: 'brief', campaignId: 'c1', label: 'Crawl', body: async () => { await settle(); return null; } });
  assert.equal(runner.isBusy('c1', 'brief'), true);
  assert.equal(runner.isBusy('c1', 'extract'), false);
  assert.equal(runner.isBusy('c2', 'brief'), false);
  await runner.drain();
  assert.equal(runner.isBusy('c1', 'brief'), false);
});

test('cancelling a queued job stops it before it starts', async () => {
  const runner = new JobRunner({ concurrency: 1 });
  let secondRan = false;
  runner.submit({ stage: 'brief', campaignId: 'c1', label: 'First', body: async () => { await settle(); return null; } });
  const second = runner.submit({ stage: 'brief', campaignId: 'c2', label: 'Second', body: async () => { secondRan = true; return null; } });
  assert.equal(runner.cancel(second.id), true);
  await runner.drain();
  assert.equal(secondRan, false);
  assert.equal(runner.get(second.id).state, 'cancelled');
});

test('a running job sees the abort signal', async () => {
  const runner = new JobRunner();
  const job = runner.submit({
    stage: 'transcribe',
    campaignId: 'c1',
    label: 'Transcribe',
    body: async ctx => {
      for (let i = 0; i < 200; i += 1) {
        if (ctx.signal.aborted) throw new Error('aborted');
        await new Promise(r => setTimeout(r, 2));
      }
      return 'finished';
    },
  });
  await settle();
  assert.equal(runner.cancel(job.id), true);
  await runner.drain();
  assert.equal(runner.get(job.id).state, 'cancelled');
});

test('cancel returns false once a job has finished', async () => {
  const runner = new JobRunner();
  const job = runner.submit({ stage: 'brief', campaignId: 'c1', label: 'Crawl', body: async () => null });
  await runner.drain();
  assert.equal(runner.cancel(job.id), false);
});

test('history is trimmed to the limit, newest kept', async () => {
  const runner = new JobRunner({ historyLimit: 3 });
  for (let i = 0; i < 8; i += 1) {
    runner.submit({ stage: 'brief', campaignId: `c${i}`, label: 'Crawl', body: async () => i });
    await runner.drain();
  }
  const all = runner.list();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map(j => j.campaignId), ['c7', 'c6', 'c5']);
});

test('list filters by campaign and sorts newest first', async () => {
  const runner = new JobRunner();
  runner.submit({ stage: 'brief', campaignId: 'c1', label: 'A', body: async () => null });
  await runner.drain();
  runner.submit({ stage: 'extract', campaignId: 'c1', label: 'B', body: async () => null });
  runner.submit({ stage: 'brief', campaignId: 'c2', label: 'C', body: async () => null });
  await runner.drain();
  const scoped = runner.list({ campaignId: 'c1' });
  assert.equal(scoped.length, 2);
  assert.equal(scoped[0].label, 'B');
});

test('jobSummary drops the log and the result but reports the line count', async () => {
  const runner = new JobRunner();
  const job = runner.submit({ stage: 'brief', campaignId: 'c1', label: 'Crawl', body: async ctx => { ctx.log('one'); ctx.log('two'); return { big: 'payload' }; } });
  await runner.drain();
  const summary = jobSummary(runner.get(job.id));
  assert.equal(summary.logLines, 2);
  assert.equal('log' in summary, false);
  assert.equal('result' in summary, false);
  assert.equal(summary.state, 'done');
});

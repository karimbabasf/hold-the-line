import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReportBatch } from '../src/console/events.ts';
import { createReporter } from '../src/mcp/report.ts';

/**
 * The reporting channel out of the tool process.
 *
 * Two properties matter more than delivery speed, and both are tested here
 * rather than assumed. A tool call must never fail because nobody is
 * watching the console, and a telephony restart must not swallow what
 * happened while it was down.
 */

interface Recorded {
  auth: string | undefined;
  frames: ReportBatch['frames'];
}

function fakeFetch(): {
  impl: typeof fetch;
  posts: Recorded[];
  fail: (mode: 'refuse' | 'error' | 'none') => void;
} {
  const posts: Recorded[] = [];
  let mode: 'refuse' | 'error' | 'none' = 'none';
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (mode === 'refuse') throw new Error('ECONNREFUSED');
    const headers = new Headers(init?.headers ?? {});
    const body = JSON.parse(String(init?.body ?? '{}')) as ReportBatch;
    if (mode === 'error') return new Response('nope', { status: 500 });
    posts.push({ auth: headers.get('authorization') ?? undefined, frames: body.frames });
    return new Response(JSON.stringify({ accepted: body.frames.length }), { status: 202 });
  }) as unknown as typeof fetch;
  return { impl, posts, fail: (m) => { mode = m; } };
}

function reporterOn(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return createReporter({
    url: 'http://127.0.0.1:8791/ingest',
    secret: 'ingest-secret',
    fetchImpl,
    retryMs: 1,
    ...overrides,
  });
}

test('reporting is a fire and forget call that returns nothing to await', () => {
  const { impl } = fakeFetch();
  const reporter = reporterOn(impl);
  const returned: unknown = reporter.report({ type: 'hold', status: 'started' });
  assert.equal(returned, undefined, 'a tool call must never be able to await the console');
  reporter.stop();
});

test('a tool call is not failed by a console that is not there', async () => {
  const fake = fakeFetch();
  fake.fail('refuse');
  const reporter = reporterOn(fake.impl);

  assert.doesNotThrow(() => {
    reporter.report({ type: 'lane', name: 'state rules', tool: 'state_rules.get', status: 'pending' });
  });
  await reporter.settle();
  assert.equal(fake.posts.length, 0);
  assert.equal(reporter.pending(), 1, 'the event was dropped instead of queued');
  reporter.stop();
});

test('events queued while telephony was down are delivered when it comes back', async () => {
  const fake = fakeFetch();
  fake.fail('refuse');
  const reporter = reporterOn(fake.impl);

  reporter.report({ type: 'call', status: 'started', claim_id: 'CLM-40218' });
  reporter.report({ type: 'lane', name: 'state rules', tool: 'state_rules.get', status: 'pending' });
  await reporter.settle();
  assert.equal(fake.posts.length, 0);

  fake.fail('none');
  await reporter.flush();

  assert.equal(reporter.pending(), 0);
  const delivered = fake.posts.flatMap((p) => p.frames);
  assert.equal(delivered.length, 2, 'events were lost across the restart');
  assert.equal(delivered[0]?.event.type, 'call');
  assert.equal(delivered[1]?.event.type, 'lane');
  reporter.stop();
});

test('a 500 from the ingest route is retried, not discarded', async () => {
  const fake = fakeFetch();
  fake.fail('error');
  const reporter = reporterOn(fake.impl);

  reporter.report({ type: 'hold', status: 'started' });
  await reporter.settle();
  assert.equal(reporter.pending(), 1);

  fake.fail('none');
  await reporter.flush();
  assert.equal(reporter.pending(), 0);
  reporter.stop();
});

test('every batch presents the bearer token', async () => {
  const fake = fakeFetch();
  const reporter = reporterOn(fake.impl);

  reporter.report({ type: 'hold', status: 'started' });
  await reporter.flush();

  assert.equal(fake.posts[0]?.auth, 'Bearer ingest-secret');
  reporter.stop();
});

test('each frame carries the wall clock of the moment it happened', async () => {
  const fake = fakeFetch();
  let clock = 5_000;
  const reporter = reporterOn(fake.impl, { now: () => clock });

  reporter.report({ type: 'lane', name: 'state rules', tool: 'state_rules.get', status: 'pending' });
  clock += 3_400;
  reporter.report({ type: 'lane', name: 'state rules', tool: 'state_rules.get', status: 'done', elapsed_ms: 3400 });
  await reporter.flush();

  const frames = fake.posts.flatMap((p) => p.frames);
  assert.deepEqual(frames.map((f) => f.at), [5_000, 8_400]);
  reporter.stop();
});

test('the queue is bounded, and says how much it dropped', async () => {
  const fake = fakeFetch();
  fake.fail('refuse');
  const reporter = reporterOn(fake.impl, { maxQueue: 10 });

  for (let i = 0; i < 50; i++) {
    reporter.report({ type: 'lane', name: `lane ${i}`, tool: `tool.${i}`, status: 'pending' });
  }
  await reporter.settle();

  assert.equal(reporter.pending(), 10, 'the queue grew past its bound');
  assert.equal(reporter.dropped(), 40);

  // The oldest went, not the newest: what is on screen now matters more than
  // what was on screen a minute ago.
  fake.fail('none');
  await reporter.flush();
  const delivered = fake.posts.flatMap((p) => p.frames);
  assert.match(JSON.stringify(delivered[0]), /lane 40/);
  assert.match(JSON.stringify(delivered.at(-1)), /lane 49/);
  reporter.stop();
});

test('an unconfigured reporter is inert rather than noisy', async () => {
  const fake = fakeFetch();
  const reporter = createReporter({ fetchImpl: fake.impl });

  reporter.report({ type: 'hold', status: 'started' });
  await reporter.flush();

  assert.equal(reporter.pending(), 0);
  assert.equal(fake.posts.length, 0, 'reported to an ingest route with no secret');
  reporter.stop();
});

test('a batch is capped so one POST cannot exceed the body limit', async () => {
  const fake = fakeFetch();
  const reporter = reporterOn(fake.impl, { batchSize: 4 });

  for (let i = 0; i < 9; i++) {
    reporter.report({ type: 'lane', name: `lane ${i}`, tool: `tool.${i}`, status: 'pending' });
  }
  await reporter.flush();

  assert.deepEqual(fake.posts.map((p) => p.frames.length), [4, 4, 1]);
  reporter.stop();
});

test('an event queued while a batch is in flight is not dropped in its place', async () => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const delivered: string[] = [];
  let firstPost = true;

  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as ReportBatch;
    if (firstPost) {
      firstPost = false;
      await held;
    }
    for (const f of body.frames) delivered.push((f.event as { name: string }).name);
    return new Response('{}', { status: 202 });
  }) as unknown as typeof fetch;

  const reporter = reporterOn(impl, { batchSize: 2, maxQueue: 2 });

  reporter.report({ type: 'lane', name: 'a', tool: 'a', status: 'pending' });
  reporter.report({ type: 'lane', name: 'b', tool: 'b', status: 'pending' });
  // Let the batch reach the POST and stop there.
  await new Promise((r) => setTimeout(r, 10));

  // The bound trims the queue while that POST is still open.
  reporter.report({ type: 'lane', name: 'c', tool: 'c', status: 'pending' });
  reporter.report({ type: 'lane', name: 'd', tool: 'd', status: 'pending' });
  reporter.report({ type: 'lane', name: 'e', tool: 'e', status: 'pending' });

  release();
  await reporter.flush();

  assert.ok(delivered.includes('d'), `d was never sent: delivered ${delivered.join(',')}`);
  assert.ok(delivered.includes('e'), `e was never sent: delivered ${delivered.join(',')}`);
  assert.equal(reporter.pending(), 0);
  // Only the frames the bound actually evicted are counted as dropped.
  assert.equal(reporter.dropped(), 5 - delivered.length);
  reporter.stop();
});

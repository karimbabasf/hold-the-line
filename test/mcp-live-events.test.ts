import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConsoleEventBody } from '../src/console/events.ts';
import { createLaneWindow } from '../src/mcp/telemetry.ts';
import { callTool, runDemoFanout, setConsoleReport } from '../src/mcp/server.ts';

/**
 * What a tool call puts on the operator's screen.
 *
 * The defect this covers: `lane`, `lanes_summary` and `number` were produced
 * nowhere in the live path. They existed only inside the recorded fixture, so
 * a console watching a real call showed five empty panes and a demo replay
 * showed all five full. These tests run the real tools and assert on what
 * they reported.
 */

function capture(): { events: ConsoleEventBody[]; restore: () => void } {
  const events: ConsoleEventBody[] = [];
  const previous = setConsoleReport((event) => { events.push(event); });
  return { events, restore: () => { setConsoleReport(previous); } };
}

function lanes(events: ConsoleEventBody[], tool: string): ConsoleEventBody[] {
  return events.filter((e) => e.type === 'lane' && e.tool === tool);
}

test('a tool call reports a lane pending, then done with its real timing', async () => {
  const { events, restore } = capture();
  try {
    await callTool('policy.lookup', { phone: '+14155550142' });
  } finally {
    restore();
  }

  const rows = lanes(events, 'policy.lookup');
  assert.equal(rows.length, 2, 'a tool call has to open and close its lane');
  assert.equal((rows[0] as { status: string }).status, 'pending');

  const done = rows[1] as { status: string; elapsed_ms?: number; summary?: string; name: string };
  assert.equal(done.status, 'done');
  assert.equal(done.name, 'policy and deductible');
  assert.ok((done.elapsed_ms ?? 0) >= 1000, `elapsed_ms was ${done.elapsed_ms}, not a real measurement`);
  assert.match(done.summary ?? '', /deductible/);
});

test('a tool call reports the numbers it produced, tagged, and unspoken', async () => {
  const { events, restore } = capture();
  try {
    await callTool('policy.lookup', { phone: '+14155550142' });
  } finally {
    restore();
  }

  const numbers = events.filter((e) => e.type === 'number');
  assert.ok(numbers.length >= 2, 'no numbers reached the Computed pane');
  for (const n of numbers) {
    assert.equal((n as { spoken: boolean }).spoken, false);
    assert.ok((n as { from?: string }).from, 'a number was reported with no provenance');
  }
});

test('a tool that failed closes its lane and reports no numbers', async () => {
  const { events, restore } = capture();
  try {
    const result = await callTool('policy.lookup', { phone: '+15555550000' });
    assert.equal(result.isError, true);
  } finally {
    restore();
  }

  const rows = lanes(events, 'policy.lookup');
  assert.equal(rows.length, 2, 'a failed tool left its lane pending forever');
  assert.match((rows[1] as { summary?: string }).summary ?? '', /failed/);
  assert.equal(events.filter((e) => e.type === 'number').length, 0);
});

test('an unknown tool reports nothing at all', async () => {
  const { events, restore } = capture();
  try {
    await callTool('nope.not.a.tool', {});
  } finally {
    restore();
  }
  assert.deepEqual(events, []);
});

test('claim.snapshot reports the lookups it fanned out, not itself as one lane', async () => {
  const { events, restore } = capture();
  try {
    await callTool('claim.snapshot', { claim_id: '40218' });
  } finally {
    restore();
  }

  assert.equal(lanes(events, 'claim.snapshot').length, 0, 'the container reported itself as a lane');
  for (const tool of ['claim.get', 'state_rules.get', 'vehicle.get', 'valuation.comps', 'lienholder.payoff_quote', 'yard.storage_status']) {
    assert.equal(lanes(events, tool).length, 2, `${tool} did not report a lane`);
  }
  assert.ok(
    events.some((e) => e.type === 'number' && e.label === 'Lienholder payoff'),
    'the fanned-out lookups reported no numbers',
  );
});

test('the real five-lane fan-out reports a summary that is measured, not asserted', async () => {
  // The lane window is process wide, as it has to be to see a fan-out across
  // several tool calls. Let the previous test's window close before opening
  // one here, or this measures both.
  await new Promise((r) => setTimeout(r, 400));

  const { events, restore } = capture();
  let result;
  try {
    result = await runDemoFanout();
    // The window closes on a quiet period, so the summary lands just after
    // the last lane does.
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    restore();
  }

  const summaries = events.filter((e) => e.type === 'lanes_summary');
  assert.equal(summaries.length, 1, `expected one summary, got ${summaries.length}`);
  const summary = summaries[0] as { parallel_ms: number; serial_ms: number };
  assert.ok(summary.parallel_ms > 0 && summary.serial_ms > 0);
  assert.ok(
    summary.serial_ms > summary.parallel_ms * 2,
    `serial ${summary.serial_ms}ms was not meaningfully more than parallel ${summary.parallel_ms}ms`,
  );
  // The same measurement the fan-out itself made, within timer noise.
  assert.ok(Math.abs(summary.parallel_ms - result.parallel_ms) < 200);
});

test('the lane window holds open across the gap between two hops', async () => {
  const events: ConsoleEventBody[] = [];
  const window = createLaneWindow({ report: (e) => { events.push(e); }, quietMs: 50 });

  window.began();
  window.began();
  window.ended(100);
  window.ended(100);
  // A gap shorter than the quiet period: the second hop belongs to the same
  // fan-out, and closing here would report a single lane as the whole story.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(events.length, 0, 'the window closed inside the fan-out');

  window.began();
  window.ended(100);
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(events.length, 1);
  const summary = events[0] as { type: string; serial_ms: number };
  assert.equal(summary.type, 'lanes_summary');
  assert.equal(summary.serial_ms, 300, 'the summary lost a hop');
});

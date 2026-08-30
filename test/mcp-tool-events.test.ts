/**
 * What the MCP panel on the operator console is drawn from.
 *
 * `lane` only ever spoke for the five fan-out lookups, because it was
 * written for the parallel-versus-serial counter. So the two tools the agent
 * actually calls, `claim.snapshot` and `settlement.calculate`, and all five
 * gated ones, ran through the whole middle of the call reporting nothing.
 * The console now draws every tool on the server and lights each pipe as it
 * is used, which only works if every tool says so.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConsoleEventBody } from '../src/console/events.ts';
import { callTool, setConsoleReport } from '../src/mcp/server.ts';

function capture(): { events: ConsoleEventBody[]; restore: () => void } {
  const events: ConsoleEventBody[] = [];
  const previous = setConsoleReport((event) => { events.push(event); });
  return { events, restore: () => { setConsoleReport(previous); } };
}

interface ToolFrame {
  type: string;
  tool: string;
  status: string;
  elapsed_ms?: number;
  summary?: string;
  gated?: boolean;
}

function toolFrames(events: ConsoleEventBody[], tool: string): ToolFrame[] {
  return events.filter(
    (e): e is ConsoleEventBody & ToolFrame => e.type === 'tool' && (e as ToolFrame).tool === tool,
  );
}

async function run(tool: string, args: Record<string, unknown>): Promise<ConsoleEventBody[]> {
  const { events, restore } = capture();
  try {
    await callTool(tool, args);
  } finally {
    restore();
  }
  return events;
}

test('a tool that is not one of the five lanes still reports itself', async () => {
  // The one the agent is told to start with. It reported nothing at all
  // before, because `openLane` returns early for a container tool.
  const rows = toolFrames(await run('claim.snapshot', { claim_id: '40218' }), 'claim.snapshot');

  assert.equal(rows.length, 2, 'claim.snapshot has to open and close its pipe');
  assert.equal(rows[0]?.status, 'pending');
  assert.equal(rows[1]?.status, 'done');
  assert.ok((rows[1]?.elapsed_ms ?? -1) >= 0, 'the done frame carries no timing');
  assert.equal(rows[1]?.gated, undefined, 'claim.snapshot is not a gated tool');
});

test('a lane tool reports both a lane and a tool, and they agree', async () => {
  const events = await run('policy.lookup', { phone: '+14155550142' });

  const lanes = events.filter((e) => e.type === 'lane');
  const tools = toolFrames(events, 'policy.lookup');
  assert.equal(lanes.length, 2, 'the fan-out counter still needs its lane events');
  assert.equal(tools.length, 2, 'and the panel needs its tool events');
  assert.equal(tools[1]?.status, 'done');
  // Same lookup, so the same sentence reaches both panes.
  assert.match(tools[1]?.summary ?? '', /deductible/);
});

test('a gated tool says it is gated, on both frames', async () => {
  // Every status carries the flag, so a console that connects mid-call and
  // sees only the `done` frame still draws the lock.
  const rows = toolFrames(
    await run('coverage.deny', { claim_id: 'CLM-40218', reason: 'test' }),
    'coverage.deny',
  );

  assert.ok(rows.length >= 1, 'coverage.deny reported nothing');
  for (const row of rows) {
    assert.equal(row.gated, true, `${row.status} frame did not say it was gated`);
  }
});

test('a summary is one line a projector can read, never a dump', async () => {
  const events = await run('settlement.calculate', { retain_salvage: false });
  const done = toolFrames(events, 'settlement.calculate').find((r) => r.status === 'done');

  assert.ok(done, 'settlement.calculate never closed its pipe');
  if (done?.summary !== undefined) {
    assert.ok(done.summary.length <= 60, `summary was ${done.summary.length} chars: ${done.summary}`);
    assert.ok(!done.summary.includes('{'), 'the summary is a JSON dump, not a sentence');
  }
});

test('a tool that throws closes its pipe as an error, not as done', async () => {
  const rows = toolFrames(await run('claim.get', { claim_id: 'CLM-00000' }), 'claim.get');

  assert.equal(rows.length, 2, 'a failing tool still has to close its pipe');
  assert.equal(rows[1]?.status, 'error');
  // The status already says it failed, so the summary carries the message
  // plainly rather than repeating the word in front of it.
  assert.match(rows[1]?.summary ?? '', /no claim on file/);
});

test('the policy read inside a snapshot lights its pipe without moving the counter', async () => {
  // `claimSnapshot` reads the policy directly rather than through `lane()`,
  // because it costs no hop of its own. The console draws a pipe per tool, so
  // a dark `policy.lookup` while the agent says it has read the policy is the
  // panel contradicting the call.
  const events = await run('claim.snapshot', { claim_id: '40218' });

  const policyTools = toolFrames(events, 'policy.lookup');
  assert.equal(policyTools.length, 2, 'policy.lookup never lit inside the snapshot');
  assert.equal(policyTools[1]?.status, 'done');

  // And it stayed out of the fan-out, which the summary calls six lookups.
  const policyLanes = events.filter(
    (e) => e.type === 'lane' && (e as { tool?: string }).tool === 'policy.lookup',
  );
  assert.equal(policyLanes.length, 0, 'the policy read entered the fan-out counter');
});

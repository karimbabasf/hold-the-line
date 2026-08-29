import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodeSSE,
  isConsoleEvent,
  parseSSE,
  recordedNorthvaneCall,
  type ConsoleEvent,
} from '../src/console/events.ts';

test('encodes a lane event as one SSE frame with event, id and data', () => {
  const ev: ConsoleEvent = { type: 'lane', t: 8_000, name: 'state rules', tool: 'state_rules.get', status: 'pending' };
  const frame = encodeSSE(ev, 3);
  assert.equal(frame, 'event: lane\nid: 3\ndata: {"type":"lane","t":8000,"name":"state rules","tool":"state_rules.get","status":"pending"}\n\n');
});

test('round-trips a single event through encode and parse', () => {
  const ev: ConsoleEvent = { type: 'hold', t: 5_000, status: 'started' };
  const [decoded] = parseSSE(encodeSSE(ev, 0));
  assert.deepEqual(decoded, ev);
});

test('round-trips several events concatenated on the wire, in order', () => {
  const events: ConsoleEvent[] = [
    { type: 'call', t: 0, status: 'started', claim_id: 'CLM-40218' },
    { type: 'hold', t: 5_000, status: 'started' },
    { type: 'gate', t: 70_000, id: 'gate-1', tool: 'offer.state_settlement', status: 'opened', wanted: 'draft' },
  ];
  const wire = events.map((e, i) => encodeSSE(e, i)).join('');
  assert.deepEqual(parseSSE(wire), events);
});

test('a frame split across a data field with an embedded newline stays one event', () => {
  // Per the SSE spec, repeated `data:` lines within one frame join with a
  // newline. JSON.stringify never emits raw newlines, but this proves the
  // decoder does not require it to.
  const wire = 'event: number\nid: 1\ndata: {"type":"number",\ndata: "t":1,"label":"x","value":1}\n\n';
  const [decoded] = parseSSE(wire);
  assert.deepEqual(decoded, { type: 'number', t: 1, label: 'x', value: 1 });
});

test('drops a block with no data field rather than throwing', () => {
  assert.deepEqual(parseSSE('event: lane\nid: 9\n\n'), []);
});

test('ignores blank trailing separators', () => {
  const ev: ConsoleEvent = { type: 'call', t: 0, status: 'started' };
  assert.deepEqual(parseSSE(`${encodeSSE(ev, 0)}\n\n`), [ev]);
});

test('the type guard accepts only known event types with a numeric t', () => {
  assert.equal(isConsoleEvent({ type: 'hold', t: 0, status: 'started' }), true);
  assert.equal(isConsoleEvent({ type: 'not-a-real-type', t: 0 }), false);
  assert.equal(isConsoleEvent({ type: 'hold' }), false);
  assert.equal(isConsoleEvent({ type: 'hold', t: '0' }), false);
  assert.equal(isConsoleEvent(null), false);
  assert.equal(isConsoleEvent('hold'), false);
});

test('parseSSE drops a decoded object that is not a console event', () => {
  const wire = 'event: mystery\nid: 0\ndata: {"type":"mystery","t":0}\n\n';
  assert.deepEqual(parseSSE(wire), []);
});

/**
 * The recorded call is the demo, so its shape gets the same scrutiny the
 * settlement engine's numbers get in `test/settle.test.ts`: every claim this
 * project makes about itself, checked against the actual fixture rather
 * than asserted in prose.
 */
test('the recorded call is non-empty and strictly ordered by t', () => {
  const events = recordedNorthvaneCall();
  assert.ok(events.length > 20, `expected a real transcript, got ${events.length} events`);
  let last = -Infinity;
  for (const e of events) {
    assert.ok(e.t >= last, `event out of order: t=${e.t} after t=${last}`);
    last = e.t;
  }
});

test('the call is bookended by call.started at t=0 and call.ended last', () => {
  const events = recordedNorthvaneCall();
  const first = events[0];
  const lastEvent = events[events.length - 1];
  assert.equal(first?.type, 'call');
  assert.equal(first?.status, 'started');
  assert.equal(first?.t, 0);
  assert.equal(lastEvent?.type, 'call');
  assert.equal(lastEvent?.status, 'ended');
});

test('every number event is tagged, nothing recalled in the recording', () => {
  for (const e of recordedNorthvaneCall()) {
    if (e.type !== 'number') continue;
    assert.ok(e.from === 'computed' || e.from === 'record', `${e.label} is untagged`);
    if (e.from === 'computed') assert.ok(e.run_id, `${e.label} is computed with no run_id`);
    if (e.from === 'record') assert.ok(e.source, `${e.label} is a record with no source`);
  }
});

test('every gate transition follows an opened event for the same id', () => {
  const events = recordedNorthvaneCall();
  const opened = new Set<string>();
  for (const e of events) {
    if (e.type !== 'gate') continue;
    if (e.status === 'opened') {
      opened.add(e.id);
      assert.ok(e.wanted, `gate ${e.id} opened with no draft`);
      continue;
    }
    // gate-3 is the pre-authorised confirmation: it approves without a
    // fresh operator gate, which is the point of pre-authorisation, so it
    // is exempt from needing its own 'opened' event.
    if (e.auto) continue;
    assert.ok(opened.has(e.id), `gate ${e.id} resolved with status ${e.status} but was never opened`);
  }
});

test('every gate event names its tool, not only the ones that open one', () => {
  // Live, this is arguments.tool_name off a call_tool envelope whose own
  // name is always "call_tool". Every status carries it, not only 'opened',
  // so a client that only sees a later status still knows what was approved.
  for (const e of recordedNorthvaneCall()) {
    if (e.type !== 'gate') continue;
    assert.ok(e.tool.length > 0, `gate ${e.id} at t=${e.t} has no tool`);
  }
});

test('an approved gate carries what was actually said', () => {
  for (const e of recordedNorthvaneCall()) {
    if (e.type === 'gate' && e.status === 'approved') {
      assert.ok(e.said && e.said.length > 0, `gate ${e.id} approved with nothing said`);
    }
  }
});

test('the lanes summary is derived from the five lanes, not a separate guess', () => {
  const events = recordedNorthvaneCall();
  const done = events.filter((e): e is Extract<ConsoleEvent, { type: 'lane' }> => e.type === 'lane' && e.status === 'done');
  const summary = events.find((e): e is Extract<ConsoleEvent, { type: 'lanes_summary' }> => e.type === 'lanes_summary');

  assert.equal(done.length, 5);
  assert.ok(summary);
  const serial = done.reduce((a, l) => a + (l.elapsed_ms ?? 0), 0);
  const parallel = Math.max(...done.map((l) => l.elapsed_ms ?? 0));
  assert.equal(summary?.serial_ms, serial);
  assert.equal(summary?.parallel_ms, parallel);
  // The spec's headline number: 3.4s parallel versus 11.1s serial.
  assert.equal(summary?.parallel_ms, 3_400);
  assert.equal(summary?.serial_ms, 11_100);
});

test('the hold clock does not run across the suspended gap', () => {
  const events = recordedNorthvaneCall();
  const suspended = events.find((e) => e.type === 'session' && e.status === 'suspended');
  const stoppedAtDrop = events.find((e) => e.type === 'hold' && e.status === 'stopped' && e.t === suspended?.t);
  const resumed = events.find((e) => e.type === 'session' && e.status === 'resumed');
  const startedAtResume = events.find((e) => e.type === 'hold' && e.status === 'started' && e.t === resumed?.t);
  assert.ok(stoppedAtDrop, 'hold did not stop when the session suspended');
  assert.ok(startedAtResume, 'hold did not resume when the session resumed');
});

test('a resumed session carries the same run ids across the drop', () => {
  const events = recordedNorthvaneCall();
  const resumed = events.find((e): e is Extract<ConsoleEvent, { type: 'session' }> => e.type === 'session' && e.status === 'resumed');
  assert.ok(resumed?.run_ids && resumed.run_ids.length > 0);
  const numberRunIds = new Set(
    events.filter((e): e is Extract<ConsoleEvent, { type: 'number' }> => e.type === 'number' && e.t <= (resumed?.t ?? 0)).map((e) => e.run_id),
  );
  for (const id of resumed?.run_ids ?? []) {
    assert.ok(numberRunIds.has(id), `resumed run_id ${id} was never produced before the drop`);
  }
});

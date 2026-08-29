import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSSE, type ConsoleEvent, type ReportFrame } from '../src/console/events.ts';
import { createLiveConsole } from '../src/telephony/live-console.ts';
import { extractSpokenNumbers } from '../src/telephony/spoken-numbers.ts';

/**
 * The console's SSE hub: what a client that connects mid-call is given, what
 * the ingest route accepts from the tool process, and the provenance ledger
 * that decides whether a number the agent said out loud is tagged computed,
 * traced to a record, or shown red as recalled.
 *
 * All of it runs with no socket. `sink()` is the whole of what the hub needs
 * from a response.
 */

interface Sink {
  chunks: string[];
  write(chunk: string): void;
  events(): ConsoleEvent[];
}

function sink(): Sink {
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk) { chunks.push(chunk); },
    events() { return parseSSE(chunks.join('')); },
  };
}

function frame(at: number, event: ReportFrame['event']): ReportFrame {
  return { at, event };
}

const SECRET = 'ingest-secret';

test('an event reaches every attached client', () => {
  const live = createLiveConsole();
  const a = sink();
  const b = sink();
  live.attach(a);
  live.attach(b);

  live.emit({ type: 'call', status: 'started', caller: '+14155550142' });

  assert.equal(a.events().length, 1);
  assert.deepEqual(b.events()[0]?.type, 'call');
  live.detach(b);
  live.emit({ type: 'hold', status: 'started' });
  assert.equal(a.events().length, 2);
  assert.equal(b.events().length, 1, 'a detached client kept receiving');
});

test('a client that connects mid-call is given the backlog', () => {
  const live = createLiveConsole();
  live.emit({ type: 'call', status: 'started', claim_id: 'CLM-40218' });
  live.emit({ type: 'lane', name: 'policy and deductible', tool: 'policy.lookup', status: 'pending' });
  live.emit({ type: 'lane', name: 'policy and deductible', tool: 'policy.lookup', status: 'done', elapsed_ms: 1100 });

  const late = sink();
  live.attach(late);

  const replayed = late.events();
  assert.equal(replayed.length, 3, 'the late client got no catch-up');
  assert.equal(replayed[0]?.type, 'call');
  assert.equal(replayed[2]?.type, 'lane');

  // And it keeps receiving after the catch-up.
  live.emit({ type: 'lanes_summary', parallel_ms: 3400, serial_ms: 11100 });
  assert.equal(late.events().length, 4);
});

test('a reconnecting client gets only what it missed', () => {
  const live = createLiveConsole();
  live.emit({ type: 'call', status: 'started' });
  live.emit({ type: 'hold', status: 'started' });
  live.emit({ type: 'lane', name: 'state rules', tool: 'state_rules.get', status: 'pending' });

  const back = sink();
  live.attach(back, '1');

  const replayed = back.events();
  assert.equal(replayed.length, 1, 'replayed frames the client already had');
  assert.equal(replayed[0]?.type, 'lane');
});

test('the buffer is bounded, and still starts a late client with the call and the hold', () => {
  const live = createLiveConsole({ bufferLimit: 5 });
  live.emit({ type: 'call', status: 'started', claim_id: 'CLM-40218' });
  live.emit({ type: 'hold', status: 'started' });
  for (let i = 0; i < 40; i++) {
    live.emit({ type: 'lane', name: `lane ${i}`, tool: `tool.${i}`, status: 'pending' });
  }

  const late = sink();
  live.attach(late);
  const replayed = late.events();

  assert.ok(replayed.length <= 7, `buffer grew without limit: ${replayed.length} frames`);
  assert.equal(replayed[0]?.type, 'call', 'a late client cannot render a call it was never told started');
  assert.equal(replayed[1]?.type, 'hold', 'the hold clock would never start for a late client');
  assert.equal(replayed.at(-1)?.type, 'lane');
  assert.match(JSON.stringify(replayed.at(-1)), /lane 39/);
});

test('a new call clears the previous call out of the buffer', () => {
  const live = createLiveConsole();
  live.emit({ type: 'call', status: 'started', claim_id: 'CLM-1' });
  live.emit({ type: 'lane', name: 'old', tool: 'old.tool', status: 'pending' });
  live.emit({ type: 'call', status: 'started', claim_id: 'CLM-2' });

  const late = sink();
  live.attach(late);
  const replayed = late.events();

  assert.equal(replayed.length, 1);
  assert.equal(JSON.parse(JSON.stringify(replayed[0]))['claim_id'], 'CLM-2');
});

// ---------------------------------------------------------------------------
// Ingest.

test('ingest refuses a batch with no bearer token', () => {
  const live = createLiveConsole({ ingestSecret: SECRET });
  const client = sink();
  live.attach(client);

  const result = live.ingest(undefined, JSON.stringify({ frames: [frame(Date.now(), { type: 'hold', status: 'started' })] }));

  assert.equal(result.status, 401);
  assert.equal(client.events().length, 0, 'an unauthenticated frame reached the console');
});

test('ingest refuses a batch with the wrong bearer token', () => {
  const live = createLiveConsole({ ingestSecret: SECRET });
  const result = live.ingest('Bearer wrong-secret', JSON.stringify({ frames: [] }));
  assert.equal(result.status, 401);
});

test('ingest fails closed when no secret is configured', () => {
  const live = createLiveConsole();
  const client = sink();
  live.attach(client);

  const result = live.ingest('Bearer anything', JSON.stringify({ frames: [frame(Date.now(), { type: 'hold', status: 'started' })] }));

  assert.equal(result.status, 503);
  assert.equal(client.events().length, 0);
});

test('ingest stamps t from the call start, not from the reporter', () => {
  let clock = 1_000_000;
  const live = createLiveConsole({ ingestSecret: SECRET, now: () => clock });
  const client = sink();
  live.attach(client);

  live.emit({ type: 'call', status: 'started' });
  clock += 8_000;

  const result = live.ingest(
    `Bearer ${SECRET}`,
    JSON.stringify({
      frames: [
        frame(1_008_000, { type: 'lane', name: 'state rules', tool: 'state_rules.get', status: 'pending' }),
        frame(1_011_400, { type: 'lane', name: 'state rules', tool: 'state_rules.get', status: 'done', elapsed_ms: 3400 }),
      ],
    }),
  );

  assert.equal(result.status, 202);
  const events = client.events();
  assert.equal(events[1]?.t, 8_000);
  assert.equal(events[2]?.t, 11_400);
});

test('ingest rejects a malformed frame without dropping the good ones', () => {
  const live = createLiveConsole({ ingestSecret: SECRET });
  const client = sink();
  live.attach(client);
  live.emit({ type: 'call', status: 'started' });

  const body = JSON.stringify({
    frames: [
      frame(Date.now(), { type: 'hold', status: 'started' }),
      { at: Date.now(), event: { type: 'gate', status: 'bogus', id: 'g1', tool: 'x' } },
    ],
  });
  const result = live.ingest(`Bearer ${SECRET}`, body);

  assert.equal(result.status, 400, 'a batch with a malformed frame must not be accepted whole');
  assert.equal(client.events().length, 1, 'the malformed frame was broadcast');
});

test('ingest answers a body that is not JSON with a 400, not a throw', () => {
  const live = createLiveConsole({ ingestSecret: SECRET });
  const result = live.ingest(`Bearer ${SECRET}`, 'not json');
  assert.equal(result.status, 400);
});

// ---------------------------------------------------------------------------
// Hold, from real call state.

test('hold starts once and stops once, however many times it is told', () => {
  const live = createLiveConsole();
  const client = sink();
  live.attach(client);
  live.emit({ type: 'call', status: 'started' });

  live.holdStarted();
  live.holdStarted();
  live.holdStopped();
  live.holdStopped();

  const holds = client.events().filter((e) => e.type === 'hold');
  assert.deepEqual(holds.map((h) => (h as { status: string }).status), ['started', 'stopped']);
});

// ---------------------------------------------------------------------------
// Spoken numbers and provenance.

test('reads money out of the shapes TTS actually speaks', () => {
  assert.deepEqual(
    extractSpokenNumbers('the net settlement works out to $13,481.12'),
    [{ value: 13481.12, money: true }],
  );
  assert.deepEqual(
    extractSpokenNumbers('13,481 dollars and 12 cents'),
    [{ value: 13481.12, money: true }],
  );
  assert.deepEqual(
    extractSpokenNumbers('that is 1,000 dollars off'),
    [{ value: 1000, money: true }],
  );
  assert.deepEqual(
    extractSpokenNumbers('claim 40218, 4 days left'),
    [{ value: 40218, money: false }, { value: 4, money: false }],
  );
});

test('a number the agent says is tagged with the provenance the tool reported', () => {
  const live = createLiveConsole({ ingestSecret: SECRET });
  const client = sink();
  live.attach(client);
  live.emit({ type: 'call', status: 'started' });

  live.ingest(
    `Bearer ${SECRET}`,
    JSON.stringify({
      frames: [
        frame(Date.now(), {
          type: 'number', label: 'Net settlement, cash', value: 13481.12,
          from: 'computed', run_id: 'run-abc', unit: 'usd', spoken: false,
        }),
        frame(Date.now(), {
          type: 'number', label: 'Collision deductible', value: 1000,
          from: 'record', source: 'policy.json:deductible_collision', unit: 'usd', spoken: false,
        }),
      ],
    }),
  );

  live.noteSpokenText('Your deductible is $1,000.00 and the net settlement is ');
  live.noteSpokenText('13,481 dollars and 12 cents.');
  live.endSpokenTurn();

  const spoken = client.events().filter((e) => e.type === 'number' && e.spoken);
  assert.equal(spoken.length, 2);
  const byValue = new Map(spoken.map((e) => [(e as { value: number }).value, e as unknown as Record<string, unknown>]));
  assert.equal(byValue.get(13481.12)?.['from'], 'computed');
  assert.equal(byValue.get(13481.12)?.['run_id'], 'run-abc');
  assert.equal(byValue.get(1000)?.['from'], 'record');
  assert.equal(byValue.get(1000)?.['source'], 'policy.json:deductible_collision');
});

test('a money figure with no tool behind it is reported as recalled, not guessed at', () => {
  const live = createLiveConsole();
  const client = sink();
  live.attach(client);
  live.emit({ type: 'call', status: 'started' });

  live.noteSpokenText('I can settle this at $7,881.55 today.');
  live.endSpokenTurn();

  const spoken = client.events().filter((e) => e.type === 'number');
  assert.equal(spoken.length, 1);
  assert.equal((spoken[0] as { value: number }).value, 7881.55);
  assert.equal(
    (spoken[0] as unknown as Record<string, unknown>)['from'],
    undefined,
    'a figure no tool produced must not be tagged with a provenance',
  );
});

test('a claim number is not reported as a recalled figure', () => {
  const live = createLiveConsole();
  const client = sink();
  live.attach(client);
  live.emit({ type: 'call', status: 'started' });

  live.noteSpokenText('I have claim 40218 here, filed on 2026-08-21.');
  live.endSpokenTurn();

  assert.equal(client.events().filter((e) => e.type === 'number').length, 0);
});

test('the same figure said twice is reported once', () => {
  const live = createLiveConsole();
  const client = sink();
  live.attach(client);
  live.emit({ type: 'call', status: 'started' });

  live.noteSpokenText('$13,481.12');
  live.endSpokenTurn();
  live.noteSpokenText('again, $13,481.12');
  live.endSpokenTurn();

  assert.equal(client.events().filter((e) => e.type === 'number').length, 1);
});

test('a hold asked for before the call is reported waits for it', () => {
  const live = createLiveConsole();
  const client = sink();
  live.attach(client);

  // This is the real order on the first turn: the turn wrapper opens the
  // hold, then the bridge reports the call it just created.
  live.holdStarted();
  live.emit({ type: 'call', status: 'started', claim_id: 'CLM-40218' });

  const events = client.events();
  assert.equal(events[0]?.type, 'call', 'the hold was reported before the call it belongs to');
  assert.equal(events[1]?.type, 'hold');
  for (const event of events) {
    assert.ok(event.t >= 0 && event.t < 1000, `t was ${event.t}, measured from something other than the call`);
  }
});

test('a hold that starts and stops before any call never reports a negative clock', () => {
  const live = createLiveConsole();
  const client = sink();
  live.attach(client);

  live.holdStarted();
  live.holdStopped();

  assert.equal(client.events().length, 0, 'a hold with no call behind it was reported anyway');
});

// ---------------------------------------------------------------------------
// Found by Qodo.

test('a spoken dollar amount never inherits a percentage of the same number', () => {
  const live = createLiveConsole({ ingestSecret: SECRET });
  const client = sink();
  live.attach(client);
  live.emit({ type: 'call', status: 'started' });

  // The real pair: claim.json reports a $75.00 storage rate, state_rules
  // reports a 75% threshold. Both are 7500 cents, and which one a single
  // numeric key holds is then decided by which lane happened to land last.
  live.emit({
    type: 'number', label: 'Yard storage rate', value: 75,
    from: 'record', source: 'claim.json:storage_per_day', unit: 'usd', spoken: false,
  });
  live.emit({
    type: 'number', label: 'Total loss threshold', value: 75,
    from: 'record', source: 'state_rules.json:total_loss_threshold_pct', unit: 'percent', spoken: false,
  });

  live.noteSpokenText('Storage runs $75.00 a day.');
  live.endSpokenTurn();

  const spoken = client.events().filter((e) => e.type === 'number' && e.spoken);
  assert.equal(spoken.length, 1);
  const said = spoken[0] as unknown as Record<string, unknown>;
  assert.equal(said['label'], 'Yard storage rate');
  assert.equal(said['unit'], 'usd');
  assert.equal(said['source'], 'claim.json:storage_per_day');
});

test('a resumed session anchors the call clock instead of stamping everything zero', () => {
  let clock = 2_000_000;
  const live = createLiveConsole({ now: () => clock });
  const client = sink();
  live.attach(client);

  // A telephony restart loses the call, and a caller ringing back resumes.
  // The bridge reports a session, never a call.
  live.broadcast({ type: 'session', t: 0, status: 'resumed', session_id: 'sess-7c21' });
  clock += 4_000;
  live.emit({ type: 'lane', name: 'state rules', tool: 'state_rules.get', status: 'pending' });

  const events = client.events();
  assert.equal(events[0]?.t, 0);
  assert.equal(events[1]?.t, 4_000, 'every event after a resume was stamped t: 0');
});

test('a resumed call still opens the hold that was waiting on it', () => {
  const live = createLiveConsole();
  const client = sink();
  live.attach(client);

  live.holdStarted();
  live.broadcast({ type: 'session', t: 0, status: 'resumed', session_id: 'sess-7c21' });

  const holds = client.events().filter((e) => e.type === 'hold');
  assert.equal(holds.length, 1, 'the hold never opened on a resumed call');
});

test('a late client on a resumed call is told the session resumed', () => {
  const live = createLiveConsole({ bufferLimit: 3 });
  live.broadcast({ type: 'session', t: 0, status: 'resumed', session_id: 'sess-7c21' });
  for (let i = 0; i < 10; i++) {
    live.emit({ type: 'lane', name: `lane ${i}`, tool: `tool.${i}`, status: 'pending' });
  }

  const late = sink();
  live.attach(late);
  assert.equal(late.events()[0]?.type, 'session', 'a late client saw a call with no beginning');
});

test('a second caller does not fold their spoken figures into the call on screen', () => {
  const live = createLiveConsole();
  const client = sink();
  live.attach(client);

  live.emit({ type: 'call', status: 'started', caller: '+14155550142' });
  live.emit({
    type: 'number', label: 'Net settlement, cash', value: 13481.12,
    from: 'computed', run_id: 'run-a', unit: 'usd', spoken: false,
  });

  // Another caller's turn, running at the same time. The console shows one
  // call, so this one's speech must not land on it.
  live.noteSpokenText('Your settlement is $9,180.12.', '+14155559999');
  live.endSpokenTurn('+14155559999');
  assert.equal(client.events().filter((e) => e.type === 'number' && e.spoken).length, 0);

  // The caller the console is actually showing still gets through.
  live.noteSpokenText('Your settlement is 13,481 dollars and 12 cents.', '+14155550142');
  live.endSpokenTurn('+14155550142');
  const spoken = client.events().filter((e) => e.type === 'number' && e.spoken);
  assert.equal(spoken.length, 1);
  assert.equal((spoken[0] as { value: number }).value, 13481.12);
});

test('a second caller does not move the hold clock of the call on screen', () => {
  const live = createLiveConsole();
  const client = sink();
  live.attach(client);

  live.emit({ type: 'call', status: 'started', caller: '+14155550142' });
  live.holdStarted('+14155550142');
  live.holdStopped('+14155559999');

  const holds = client.events().filter((e) => e.type === 'hold');
  assert.deepEqual(holds.map((h) => (h as { status: string }).status), ['started']);
});

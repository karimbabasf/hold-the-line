/**
 * The console has to light up when the call starts, not when the harness
 * catches up with it.
 *
 * `call started` used to be reported by the bridge, after awaiting a
 * TrueForge session. Everything else the console renders is anchored on that
 * frame, so the screen sat idle and the caller's own first sentence sat in a
 * queue for the length of a session round trip. These cover the two paths
 * that now open a call earlier, and the one that closes it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveConsole, readTelnyxStatus } from '../src/telephony/live-console.ts';

/** Collects what one client would have received. */
function watch(live: ReturnType<typeof createLiveConsole>) {
  const frames: string[] = [];
  live.attach({ write: (chunk: string) => { frames.push(chunk); } });
  return {
    events: () =>
      frames
        .flatMap((f) => f.split('\n'))
        .filter((l) => l.startsWith('data: '))
        .map((l) => JSON.parse(l.slice('data: '.length)) as Record<string, unknown>),
  };
}

test('a call opens on the first turn, before the harness reports it', () => {
  const live = createLiveConsole();
  const seen = watch(live);

  live.callStarted('+14155550101', '+14155550101');
  live.callerSaid('My claim number is CLM-40218.', '+14155550101');

  const events = seen.events();
  assert.equal(events[0]?.['type'], 'call');
  assert.equal(events[0]?.['status'], 'started');
  // The caller's words go out with the call, not queued behind it.
  assert.equal(events[1]?.['type'], 'transcript');
  assert.equal(events[1]?.['who'], 'caller');
  assert.equal(live.onCall(), true);
});

test('the bridge reporting the same call again does not restart it', () => {
  const live = createLiveConsole();
  const seen = watch(live);

  live.callStarted('+14155550101', '+14155550101');
  live.callerSaid('First sentence.', '+14155550101');
  // What server.ts routes the bridge's own `call started` through.
  live.callStarted('+14155550101');

  const events = seen.events();
  assert.equal(events.filter((e) => e['type'] === 'call' && e['status'] === 'started').length, 1);
  // The transcript survives, which is the point: a second raw `call started`
  // empties the replay buffer.
  assert.equal(events.filter((e) => e['type'] === 'transcript').length, 1);
});

test('a call opened by the status callback is adopted by the first turn', () => {
  const live = createLiveConsole();
  const seen = watch(live);

  // The webhook knows the number but not the id turns are keyed on.
  live.callStarted(undefined, '+14155550101');
  // A turn arrives under Telnyx's own identifier, which is not that number.
  live.callStarted('telnyx-conversation-abc', 'telnyx-conversation-abc');
  live.callerSaid('My claim number is CLM-40218.', 'telnyx-conversation-abc');

  const events = seen.events();
  assert.equal(events.filter((e) => e['type'] === 'call' && e['status'] === 'started').length, 1);
  // The header keeps the number the webhook gave it.
  assert.equal(events[0]?.['caller'], '+14155550101');
  // And the turn was not rejected as somebody else's call.
  assert.equal(events.filter((e) => e['type'] === 'transcript').length, 1);
});

test('a caller ringing back after a hangup reopens the call', () => {
  const live = createLiveConsole();
  const seen = watch(live);

  live.callStarted('+14155550101', '+14155550101');
  live.callEnded('+14155550101');
  assert.equal(live.onCall(), false);

  live.callStarted('+14155550101', '+14155550101');
  assert.equal(live.onCall(), true);
  assert.equal(
    seen.events().filter((e) => e['type'] === 'call' && e['status'] === 'started').length,
    2,
  );
});

test('the status callback is read for what it actually says', () => {
  assert.deepEqual(
    readTelnyxStatus('CallStatus=in-progress&From=%2B14155550101&To=%2B14157238926'),
    { kind: 'started', status: 'in-progress', caller: '+14155550101' },
  );
  assert.equal(readTelnyxStatus('CallStatus=answered').kind, 'started');
  assert.equal(readTelnyxStatus('CallStatus=completed&CallDuration=61').kind, 'ended');
  assert.equal(readTelnyxStatus('CallStatus=no-answer').kind, 'ended');
  // A ringing phone is not an answered one, and a status nobody recognises is
  // not evidence of anything.
  assert.equal(readTelnyxStatus('CallStatus=ringing').kind, 'ignore');
  assert.equal(readTelnyxStatus('').kind, 'ignore');
  assert.equal(readTelnyxStatus('CallStatus=queued').kind, 'ignore');
});

test('the status callback ends a call with no caller id of its own', () => {
  const live = createLiveConsole();
  const seen = watch(live);

  live.callStarted('telnyx-conversation-abc', '+14155550101');
  // What the webhook route calls: no id, because it does not have the one
  // the turn was keyed on.
  live.callEnded();

  assert.equal(live.onCall(), false);
  assert.equal(
    seen.events().filter((e) => e['type'] === 'call' && e['status'] === 'ended').length,
    1,
  );
});

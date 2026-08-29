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

test('an end with no call showing is not held against the next call', () => {
  const live = createLiveConsole();

  // What the status callback route guards on. A `completed` for a leg that
  // never connected, or for a call this process was restarted out of, must
  // not be forwarded: `callEnded` with no call clock is held as a pending
  // end and applied to whatever starts next.
  assert.equal(live.onCall(), false);

  const seen = watch(live);
  live.callStarted('+14155550101', '+14155550101');
  assert.equal(live.onCall(), true);
  assert.equal(
    seen.events().filter((e) => e['type'] === 'call' && e['status'] === 'ended').length,
    0,
    'the new call was ended by a stale hangup',
  );
});

/**
 * The wake-up half, which is a different body on the same route.
 *
 * The TeXML status callback never delivers a start: on the real call of
 * 2026-08-29 it sent `completed`, `conversation_ended` and `analyzed` and
 * nothing else, and its application object has no event list to subscribe
 * to. What does arrive at the start is the assistant's dynamic-variables
 * webhook, POSTed as JSON before the greeting is spoken. These pin the shape
 * Telnyx documents for it, field for field.
 */
const initialization = (payload: Record<string, unknown> = {}) =>
  JSON.stringify({
    data: {
      record_type: 'event',
      id: 'event_12345678-90ab-cdef-1234-567890abcdef',
      event_type: 'assistant.initialization',
      occurred_at: '2026-08-29T10:00:00Z',
      payload: {
        telnyx_conversation_channel: 'phone_call',
        telnyx_agent_target: '+14157238926',
        telnyx_end_user_target: '+14155550101',
        telnyx_end_user_target_verified: false,
        call_control_id: 'v3:u5OAKGEPT3Dx8SZSSDRWEMdNH2OripQhO',
        assistant_id: 'assistant-c7746f9b',
        ...payload,
      },
    },
  });

test('the dynamic-variables webhook is the start of a call', () => {
  const ev = readTelnyxStatus(initialization());

  assert.equal(ev.kind, 'started');
  assert.equal(ev.status, 'assistant.initialization');
  // `telnyx_end_user_target` is the other end of the line, which on an
  // inbound-only number is the caller. It is what the header shows.
  assert.equal(ev.caller, '+14155550101');
  // Telnyx is holding the greeting until this one answers, and it wants
  // dynamic variables back rather than this endpoint's usual {ok: true}.
  assert.equal(ev.wantsVariables, true);
});

test('a start with no caller number still opens the call', () => {
  // A web call has no phone number on either end.
  const body = JSON.stringify({
    data: { event_type: 'assistant.initialization', payload: { telnyx_conversation_channel: 'web_call' } },
  });
  assert.deepEqual(readTelnyxStatus(body), { kind: 'started', status: 'assistant.initialization', wantsVariables: true });
});

test('start-side names Telnyx has not sent here are still read as a start', () => {
  // Accepted because the cost of being wrong about them is a dead screen.
  for (const event of ['call.answered', 'conversation.started', 'conversation_started']) {
    const ev = readTelnyxStatus(JSON.stringify({ data: { event_type: event } }));
    assert.equal(ev.kind, 'started', `${event} should start a call`);
    // Only the initialization webhook is waiting on a variables body.
    assert.equal(ev.wantsVariables, undefined, `${event} should not want variables`);
  }
});

test('the end of a call is read from every shape that has carried one', () => {
  // Both spellings the account actually delivered, on both wire formats.
  assert.equal(readTelnyxStatus('CallStatus=conversation_ended').kind, 'ended');
  assert.equal(readTelnyxStatus(JSON.stringify({ data: { event_type: 'conversation.ended' } })).kind, 'ended');
  assert.equal(readTelnyxStatus(JSON.stringify({ data: { event_type: 'call.hangup' } })).kind, 'ended');
  assert.equal(readTelnyxStatus(JSON.stringify({ event_type: 'completed' })).kind, 'ended');
  // A hangup carries the caller through, whichever shape it arrived in.
  const withFrom = JSON.stringify({ data: { event_type: 'call.hangup', payload: { from: '+14155550101' } } });
  assert.equal(readTelnyxStatus(withFrom).caller, '+14155550101');
});

test('post-call analysis is not a hangup and is not a start', () => {
  // `analyzed` lands after the caller has already gone. Ending the call on it
  // would end whatever call is on screen by then, which is the next one.
  assert.equal(readTelnyxStatus('CallStatus=analyzed').kind, 'ignore');
  assert.equal(readTelnyxStatus(JSON.stringify({ data: { event_type: 'conversation.analyzed' } })).kind, 'ignore');
  // A name nobody recognises is not evidence of anything, in either format.
  assert.equal(readTelnyxStatus(JSON.stringify({ data: { event_type: 'assistant.tool_called' } })).kind, 'ignore');
  assert.equal(readTelnyxStatus(JSON.stringify({ data: {} })).kind, 'ignore');
});

test('a body that is neither shape is ignored rather than thrown on', () => {
  // Telnyx is on the other end of this and a parse error would 500 at it.
  assert.equal(readTelnyxStatus('{not json at all').kind, 'ignore');
  assert.equal(readTelnyxStatus('{}').kind, 'ignore');
  assert.equal(readTelnyxStatus('null').kind, 'ignore');
  assert.equal(readTelnyxStatus('[]').kind, 'ignore');
});

test('the form-encoded callback is untouched by the JSON path', () => {
  // The hangup half still parses exactly as it did, `wantsVariables` and all:
  // only the dynamic-variables webhook is owed a variables body.
  assert.deepEqual(readTelnyxStatus('CallStatus=completed&CallDuration=61'), {
    kind: 'ended',
    status: 'completed',
  });
});

test('the webhook lights the console up before anyone has said anything', () => {
  const live = createLiveConsole();
  const seen = watch(live);

  // What server.ts does with a `started`: no id, because Telnyx's own
  // conversation id is not what the turns are keyed on.
  const ev = readTelnyxStatus(initialization());
  assert.equal(ev.kind, 'started');
  live.callStarted(undefined, ev.caller);

  assert.equal(live.onCall(), true);
  const events = seen.events();
  assert.equal(events[0]?.['type'], 'call');
  assert.equal(events[0]?.['status'], 'started');
  assert.equal(events[0]?.['caller'], '+14155550101');

  // And the first turn, which arrives after the greeting, adopts it rather
  // than opening a second call.
  live.callStarted('telnyx-conversation-abc', 'telnyx-conversation-abc');
  live.callerSaid('My claim number is CLM-40218.', 'telnyx-conversation-abc');
  assert.equal(seen.events().filter((e) => e['type'] === 'call' && e['status'] === 'started').length, 1);
  assert.equal(seen.events().filter((e) => e['type'] === 'transcript').length, 1);
});

test('a sandbox event keeps its own timing, and attachment survives the buffer', () => {
  const live = createLiveConsole();
  const t0 = Date.now();

  // `at` drives the call clock, so this reads like a call that has been
  // running for twenty seconds rather than one answered this instant.
  live.broadcast({ type: 'call', t: 0, status: 'started', caller: '+14155550101' } as never, t0);
  live.broadcast(
    { type: 'sandbox', t: 0, status: 'attached', id: 'sess-1', url: 'http://h/sessions/sess-1' } as never,
    t0 + 500,
  );

  const seen = watch(live);
  // The bridge dates `running` back across the silence it sat through,
  // because TrueForge announces no start of execution. Restamping that with
  // the arrival time collapsed the run to zero and lost the one measurement
  // the panel exists to show. Found by Qodo.
  live.broadcast(
    { type: 'sandbox', t: 4_000, status: 'running', id: 'sess-1', label: 'exec' } as never,
    t0 + 18_500,
  );
  live.broadcast({ type: 'sandbox', t: 18_500, status: 'idle', id: 'sess-1' } as never, t0 + 18_500);

  const events = seen.events();
  // A late client is handed the attachment even though it happened before it
  // connected, or the panel says "Not attached yet" against a live session.
  assert.ok(
    events.some((e) => e['type'] === 'sandbox' && e['status'] === 'attached'),
    'the attachment was not replayed to a late client',
  );

  const running = events.find((e) => e['type'] === 'sandbox' && e['status'] === 'running');
  const idle = events.find((e) => e['type'] === 'sandbox' && e['status'] === 'idle');
  assert.equal(running?.['t'], 4_000, 'the backdated start was restamped with the arrival time');
  assert.equal(idle?.['t'], 18_500);
  // Which is the whole point: the panel can report a real run length.
  assert.equal((idle?.['t'] as number) - (running?.['t'] as number), 14_500);
});

test('a sandbox time is clamped into the call it belongs to', () => {
  const live = createLiveConsole();
  const seen = watch(live);
  live.callStarted('+14155550101', '+14155550101');
  // A `t` from the future would put the run ahead of the call clock and make
  // the panel report a duration nobody waited.
  live.broadcast({ type: 'sandbox', t: 9_000_000, status: 'running', id: 'sess-1' } as never);

  const running = seen.events().find((e) => e['type'] === 'sandbox' && e['status'] === 'running');
  assert.ok((running?.['t'] as number) < 9_000_000, 'a future timestamp was taken at face value');
});

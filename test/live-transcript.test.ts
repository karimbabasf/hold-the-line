import assert from 'node:assert/strict';
import test from 'node:test';

import { isConsoleEvent, parseSSE, type ConsoleEvent } from '../src/console/events.ts';
import { createChatEndpoint, type TurnDelta } from '../src/telephony/chat-endpoint.ts';
import { createLiveConsole } from '../src/telephony/live-console.ts';
import { millis, spokenDuration } from '../src/mcp/telemetry.ts';

/**
 * What the operator console is told, and whether it is true.
 *
 * Three faults are pinned here, all found on one screenshot of the running
 * console: no transcript at all, a header stuck on "ON CALL" long after the
 * caller had gone, and a hold clock still running under it.
 */

/** A sink that keeps the frames written to it, decoded. */
function recorder() {
  let raw = '';
  return {
    sink: { write: (chunk: string) => { raw += chunk; } },
    events: (): ConsoleEvent[] => parseSSE(raw),
    raw: (): string => raw,
  };
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

test('a transcript event survives the wire and the guard', () => {
  const spoken: ConsoleEvent = {
    type: 'transcript', t: 1_200, who: 'agent', text: 'Let me pull that up.', final: false,
  };
  assert.equal(isConsoleEvent(spoken), true);
  assert.deepEqual(parseSSE(`event: transcript\nid: 0\ndata: ${JSON.stringify(spoken)}\n\n`), [spoken]);
});

test('the guard rejects a transcript that is missing what a renderer needs', () => {
  assert.equal(isConsoleEvent({ type: 'transcript', t: 0, who: 'operator', text: 'x', final: true }), false);
  assert.equal(isConsoleEvent({ type: 'transcript', t: 0, who: 'agent', final: true }), false);
  assert.equal(isConsoleEvent({ type: 'transcript', t: 0, who: 'agent', text: 'x' }), false);
});

// ---------------------------------------------------------------------------
// The transcript itself
// ---------------------------------------------------------------------------

test('one turn puts both speakers on the wire, the agent live', () => {
  const live = createLiveConsole({ now: () => 1_000 });
  const seen = recorder();
  live.attach(seen.sink);

  live.broadcast({ type: 'call', t: 0, status: 'started', caller: '+14155550142' });
  live.callerSaid('my body shop says the car is a write off', '+14155550142');
  live.noteSpokenText('I have got your file here.', '+14155550142');
  live.noteSpokenText(' The net is 13,481 dollars and 12 cents.', '+14155550142');
  live.endSpokenTurn('+14155550142');

  const transcript = seen.events().filter((e) => e.type === 'transcript');
  assert.deepEqual(
    transcript.map((e) => [e.who, e.final, e.text]),
    [
      ['caller', true, 'my body shop says the car is a write off'],
      ['agent', false, 'I have got your file here.'],
      ['agent', false, 'I have got your file here. The net is 13,481 dollars and 12 cents.'],
      ['agent', true, 'I have got your file here. The net is 13,481 dollars and 12 cents.'],
    ],
  );
});

test('the caller is heard on the first turn, after the call frame that clears the buffer', () => {
  // The first turn hands over the caller's words before the bridge has opened
  // a session and said the call began, and `call started` empties the replay
  // buffer. Broadcast in that order it would be gone from a console that
  // connected a second later.
  const live = createLiveConsole();
  live.callerSaid('claim four zero two one eight', '+14155550142');
  live.holdStarted('+14155550142');
  live.broadcast({ type: 'call', t: 0, status: 'started', caller: '+14155550142' });

  const late = recorder();
  live.attach(late.sink);

  assert.deepEqual(
    late.events().map((e) => (e.type === 'transcript' ? `${e.who}:${e.text}` : `${e.type}:${'status' in e ? e.status : ''}`)),
    ['call:started', 'caller:claim four zero two one eight', 'hold:started'],
  );
});

test('a turn the gate withheld leaves no line claiming the agent spoke', () => {
  const live = createLiveConsole();
  const seen = recorder();
  live.attach(seen.sink);
  live.broadcast({ type: 'call', t: 0, status: 'started', caller: '+1' });
  // No noteSpokenText: the shaper never saw the message, so the caller never
  // heard it.
  live.endSpokenTurn('+1');
  assert.equal(seen.events().filter((e) => e.type === 'transcript').length, 0);
});

test('a second caller does not write onto the call on screen', () => {
  const live = createLiveConsole();
  const seen = recorder();
  live.attach(seen.sink);
  live.broadcast({ type: 'call', t: 0, status: 'started', caller: '+1' });
  live.callerSaid('this is somebody else', '+2');
  live.noteSpokenText('and this is what they were told', '+2');
  assert.equal(seen.events().filter((e) => e.type === 'transcript').length, 0);
});

// ---------------------------------------------------------------------------
// Call state
// ---------------------------------------------------------------------------

test('the call ends once, and takes the hold clock with it', () => {
  const live = createLiveConsole();
  const seen = recorder();
  live.attach(seen.sink);

  live.broadcast({ type: 'call', t: 0, status: 'started', caller: '+1' });
  live.holdStarted('+1');
  assert.equal(live.onCall(), true);

  // Both paths that notice a hangup fire: the endpoint losing the socket, and
  // a held gate's abort handler.
  live.callEnded('+1');
  live.emit({ type: 'call', status: 'ended', caller: '+1' });

  const shape = seen.events().map((e) => `${e.type}:${'status' in e ? e.status : ''}`);
  assert.deepEqual(shape, ['call:started', 'hold:started', 'hold:stopped', 'call:ended']);
  assert.equal(live.onCall(), false);
});

test('a call that never started cannot end', () => {
  const live = createLiveConsole();
  const seen = recorder();
  live.attach(seen.sink);
  live.callEnded('+1');
  assert.equal(seen.events().length, 0);
});

test('a hangup before the call was reported is applied once it exists', () => {
  // The abort can land while the bridge is still awaiting a session, so the
  // end is announced before the start. Found by Qodo.
  const live = createLiveConsole();
  const seen = recorder();
  live.attach(seen.sink);

  live.callEnded('+1');
  live.broadcast({ type: 'call', t: 0, status: 'started', caller: '+1' });

  assert.deepEqual(
    seen.events().map((e) => `${e.type}:${'status' in e ? e.status : ''}`),
    ['call:started', 'call:ended'],
  );
  assert.equal(live.onCall(), false);
});

test('a caller who rings back reopens the call the bridge resumes', () => {
  // A live harness session means the bridge reports a resume, not a start, so
  // without this the console stays in "call over" for the whole new call.
  // Found by Qodo.
  const live = createLiveConsole();
  live.broadcast({ type: 'call', t: 0, status: 'started', caller: '+1' });
  live.callEnded('+1');
  assert.equal(live.onCall(), false);

  live.broadcast({ type: 'session', t: 0, status: 'resumed', session_id: 'sess-1' });
  assert.equal(live.onCall(), true);
});

test('words held from a caller who is not the one on screen are dropped', () => {
  // Before a call starts every caller is accepted, so the pending buffer has
  // to remember whose words it is holding. Found by Qodo.
  const live = createLiveConsole();
  const seen = recorder();
  live.attach(seen.sink);

  live.callerSaid('this one got through', '+1');
  live.callerSaid('this one did not', '+2');
  live.broadcast({ type: 'call', t: 0, status: 'started', caller: '+1' });

  assert.deepEqual(
    seen.events().filter((e) => e.type === 'transcript').map((e) => e.text),
    ['this one got through'],
  );
});

test('a new call reopens the header after the last one ended', () => {
  const live = createLiveConsole();
  live.broadcast({ type: 'call', t: 0, status: 'started', caller: '+1' });
  live.callEnded('+1');
  live.broadcast({ type: 'call', t: 0, status: 'started', caller: '+2' });
  assert.equal(live.onCall(), true);
});

// ---------------------------------------------------------------------------
// Who says the caller is gone
// ---------------------------------------------------------------------------

function post(body: unknown): Request {
  return new Request('http://x/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
}

test('a cancelled response is a hangup, and is reported once', async () => {
  const gone: string[] = [];
  const handler = createChatEndpoint({
    runTurn: async function* (): AsyncGenerator<TurnDelta> {
      yield { type: 'message.delta', text: 'One moment.' };
      await new Promise((r) => setTimeout(r, 50));
      yield { type: 'message.delta', text: 'Still here.' };
    },
    onCallerGone: (callerId) => { gone.push(callerId); },
  });

  const res = await handler(post({ messages: [{ role: 'user', content: 'hello' }], user: '+14155550142' }));
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  await reader.read();
  await reader.cancel(new Error('client closed the connection'));
  await new Promise((r) => setTimeout(r, 80));

  assert.deepEqual(gone, ['+14155550142']);
});

test('a turn finishing is not a call ending', async () => {
  const gone: string[] = [];
  const handler = createChatEndpoint({
    runTurn: async function* (): AsyncGenerator<TurnDelta> {
      yield { type: 'message.delta', text: 'All done.' };
    },
    onCallerGone: (callerId) => { gone.push(callerId); },
  });

  const res = await handler(post({ messages: [{ role: 'user', content: 'hello' }], user: '+14155550142' }));
  await res.text();
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(gone, []);
});

// ---------------------------------------------------------------------------
// Timings
// ---------------------------------------------------------------------------

test('a sub-millisecond lane reports what it took, not zero', () => {
  assert.equal(millis(0.41732), 0.417);
  assert.notEqual(millis(0.41732), 0);
  assert.equal(millis(3_400.5), 3400.5);
});

test('a duration reads honestly at both ends of the scale', () => {
  assert.equal(spokenDuration(0.417), '0.42ms');
  assert.equal(spokenDuration(42.4), '42ms');
  assert.equal(spokenDuration(3_400), '3.4s');
});

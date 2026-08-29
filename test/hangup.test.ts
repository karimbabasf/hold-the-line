import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatEndpoint, type TurnDelta } from '../src/telephony/chat-endpoint.ts';

/**
 * A caller who hangs up mid-approval.
 *
 * The gate holds the turn on a promise that only an operator settles, so
 * without a signal from the request side that promise never settles: the
 * waiter leaks and an operator is left judging a sentence for a call that
 * ended. The endpoint owns the request side, so this is where the hangup is
 * noticed.
 */

function post(body: unknown): Request {
  return new Request('http://x/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

test('hanging up aborts the signal the turn was given', async () => {
  let seen: AbortSignal | undefined;
  let released = false;

  const handler = createChatEndpoint({
    runTurn: async function* (_text, _caller, signal): AsyncGenerator<TurnDelta> {
      seen = signal;
      yield { type: 'message.delta', text: 'One moment.' };
      // Stands in for a gate: waits until something settles it.
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => {
          released = true;
          resolve();
        });
      });
    },
  });

  const res = await handler(post({ user: '+15550001111', messages: [{ role: 'user', content: 'hi' }] }));
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  await reader.read();

  assert.ok(seen, 'the turn was given no signal');
  assert.equal(seen?.aborted, false, 'aborted before the caller hung up');

  // The caller hangs up: the consumer stops reading and cancels the body.
  await reader.cancel();
  await new Promise((r) => setImmediate(r));

  assert.equal(seen?.aborted, true, 'the hangup did not reach the turn');
  assert.equal(released, true, 'the waiter was never released');
});

test('a turn that finishes normally is not left with an aborted signal mid-flight', async () => {
  const states: boolean[] = [];
  const handler = createChatEndpoint({
    runTurn: async function* (_text, _caller, signal): AsyncGenerator<TurnDelta> {
      yield { type: 'message.delta', text: 'a' };
      states.push(signal?.aborted ?? true);
      yield { type: 'message.delta', text: 'b' };
      states.push(signal?.aborted ?? true);
    },
  });

  const body = await (
    await handler(post({ messages: [{ role: 'user', content: 'hi' }] }))
  ).text();

  assert.deepEqual(states, [false, false]);
  assert.match(body, /"finish_reason":"stop"/);
});

test('an already-aborted request never starts a turn', async () => {
  let started = false;
  const handler = createChatEndpoint({
    // eslint-disable-next-line require-yield
    runTurn: async function* (): AsyncGenerator<TurnDelta> {
      started = true;
    },
  });

  const controller = new AbortController();
  controller.abort();
  const res = await handler(
    new Request('http://x/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal,
    }),
  );

  assert.equal(res.status, 499);
  assert.equal(started, false, 'a hung-up caller still opened a harness turn');
});

test('the abort reaches a gate waiter through the bridge', async () => {
  const { createBridge } = await import('../src/telephony/harness-bridge.ts');
  const { TrueForgeClient } = await import('../src/trueforge/client.ts');
  void TrueForgeClient;

  let settled: unknown = 'not settled';
  const controller = new AbortController();

  const forge = {
    async createSession() {
      return 'sess-1';
    },
    async *streamTurn() {
      yield { type: 'model.message', id: 'src_1', thread_id: 'main' };
      yield { type: 'model.message.delta', id: 'src_1', content: 'One moment.' };
      yield {
        type: 'tool.approval_required',
        id: 'e1',
        created_at: '2026-08-29T00:00:00Z',
        thread_id: 'main',
        tool_calls: [{ id: 'call_1', source_event_id: 'src_1' }],
      };
    },
    async findEvent() {
      return {
        type: 'model.message',
        id: 'src_1',
        thread_id: 'main',
        tool_calls: [
          {
            id: 'call_1',
            name: 'offer.state_settlement',
            arguments: { claim_id: 'CLM-40218', utterance: 'We can settle at $13,481.12.' },
          },
        ],
      };
    },
  };

  const bridge = createBridge({
    forge: forge as never,
    agentName: 'northvane',
    awaitApproval: (_gate, _caller, signal) =>
      new Promise((resolve) => {
        // Exactly the server's shape: held until a human decides, or until
        // the caller is gone.
        signal?.addEventListener('abort', () => {
          settled = null;
          resolve(null);
        });
      }),
  });

  const turn = bridge.runTurn('claim 40218', '+15550002222', controller.signal);
  const drain = (async () => {
    for await (const _ of turn) {
      /* consume */
    }
  })();

  // Give the turn long enough to reach the gate, then hang up.
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  await drain;

  assert.equal(settled, null, 'the gate waiter outlived the call');
});

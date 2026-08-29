import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatEndpoint, type TurnDelta } from '../src/telephony/chat-endpoint.ts';

function post(body: unknown): Request {
  return new Request('http://x/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function* deltas(...texts: string[]): AsyncGenerator<TurnDelta> {
  for (const text of texts) yield { type: 'message.delta', text };
}

test('returns OpenAI-shaped SSE deltas for a user turn', async () => {
  const handler = createChatEndpoint({
    runTurn: () => deltas('It is a total loss.'),
  });

  const res = await handler(
    post({ model: 'x', stream: true, messages: [{ role: 'user', content: 'Claim 40218' }] }),
  );

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

  const body = await res.text();
  assert.match(body, /"delta":\{"content":"It is a total loss\."\}/);
  assert.match(body, /"finish_reason":"stop"/);
  assert.match(body, /data: \[DONE\]/);
});

test('passes the last user message, not the first', async () => {
  let seen = '';
  const handler = createChatEndpoint({
    runTurn: (text) => {
      seen = text;
      return deltas('ok');
    },
  });

  await (
    await handler(
      post({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'second' },
        ],
      }),
    )
  ).text();

  assert.equal(seen, 'second');
});

test('accepts the array-of-parts content form Telnyx sometimes sends', async () => {
  let seen = '';
  const handler = createChatEndpoint({
    runTurn: (text) => {
      seen = text;
      return deltas('ok');
    },
  });

  await (
    await handler(
      post({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Claim 40218' }] }] }),
    )
  ).text();

  assert.equal(seen, 'Claim 40218');
});

test('forwards the caller id so a resumed call can find its checkpoint', async () => {
  let seen = '';
  const handler = createChatEndpoint({
    runTurn: (_text, callerId) => {
      seen = callerId;
      return deltas('ok');
    },
  });

  const res = await handler(
    post({ user: '+14155550142', messages: [{ role: 'user', content: 'hi' }] }),
  );
  await res.text();

  assert.equal(seen, '+14155550142');
});

test('a failure mid-stream says something rather than leaving silence', async () => {
  const handler = createChatEndpoint({
    // eslint-disable-next-line require-yield
    runTurn: async function* (): AsyncGenerator<TurnDelta> {
      throw new Error('harness died');
    },
  });

  const body = await (
    await handler(post({ messages: [{ role: 'user', content: 'hi' }] }))
  ).text();

  assert.match(body, /get a person for you/);
  assert.match(body, /data: \[DONE\]/);
});

test('rejects a request with no user message', async () => {
  const handler = createChatEndpoint({ runTurn: () => deltas('x') });
  const res = await handler(post({ messages: [{ role: 'assistant', content: 'hi' }] }));
  assert.equal(res.status, 400);
});

test('rejects a body that is not JSON', async () => {
  const handler = createChatEndpoint({ runTurn: () => deltas('x') });
  const res = await handler(
    new Request('http://x/v1/chat/completions', { method: 'POST', body: 'not json' }),
  );
  assert.equal(res.status, 400);
});

// extractText is verified against a real TrueForge v0.1.4 turn stream:
// turn.created, model.message, model.message.delta (many), turn.done.
test('extractText takes words only from model.message.delta', async () => {
  const { extractText } = await import('../src/telephony/harness-bridge.ts');

  assert.equal(extractText({ type: 'model.message.delta', content: 'Hello' }), 'Hello');
  // model.message is an empty opener; treating it as text emits a blank turn.
  assert.equal(extractText({ type: 'model.message', thread_id: 'main' }), null);
  assert.equal(extractText({ type: 'turn.created' }), null);
  assert.equal(extractText({ type: 'turn.done', state: { output: { content: 'x' } } }), null);
  assert.equal(extractText({ type: 'model.message.delta', content: '' }), null);
  assert.equal(extractText({ type: 'tool.approval_required' }), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { TrueForgeClient, TrueForgeError } from '../src/trueforge/client.ts';

test('createSession references the agent by name, not id', async () => {
  // The API rejects { agent: { id } } with a bare "Invalid input at agent",
  // which cost a live debugging cycle. Pinned so it cannot regress.
  let sentBody: unknown;
  const client = new TrueForgeClient({
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: { id: 'sess-1' } }), { status: 200 });
    },
  });

  assert.equal(await client.createSession('northvane'), 'sess-1');
  assert.deepEqual(sentBody, { agent: { name: 'northvane' } });
});

test('a failed request carries the status and body', async () => {
  const client = new TrueForgeClient({
    fetchImpl: async () => new Response('{"error":"nope"}', { status: 400 }),
  });

  await assert.rejects(
    () => client.createSession('northvane'),
    (err: unknown) => {
      assert.ok(err instanceof TrueForgeError);
      assert.equal(err.status, 400);
      assert.match(err.body, /nope/);
      return true;
    },
  );
});

test('turn input may not mix user messages with approval resumes', async () => {
  const client = new TrueForgeClient({ fetchImpl: async () => new Response('{}') });
  await assert.rejects(async () => {
    for await (const _event of client.streamTurn('s', [
      { type: 'user.message', content: 'hi' },
      {
        type: 'user.tool_approval',
        thread_id: 't',
        tool_call_id: 'c',
        approval: { status: 'allow' },
      },
    ])) {
      /* consume */
    }
  }, /must not mix/);
});

test('the connect timeout does not abort an active stream body', async () => {
  // AbortSignal.timeout() stays live for the whole response lifetime, so a
  // 30s timeout killed SSE turns mid-call. Qodo confirmed this on PR 1 after
  // I asked about it. The timeout now covers connecting only.
  const client = new TrueForgeClient({
    requestTimeoutMs: 30,
    fetchImpl: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('data: {"type":"a"}\n\n'));
            // Outlive the 30ms timeout before sending anything more.
            await new Promise((r) => setTimeout(r, 120));
            controller.enqueue(enc.encode('data: {"type":"b"}\n\n'));
            controller.close();
          },
        }),
        { status: 200 },
      ),
  });

  const seen: string[] = [];
  for await (const event of client.streamTurn('s', [{ type: 'user.message', content: 'hi' }])) {
    seen.push(event.type);
  }
  assert.deepEqual(seen, ['a', 'b']);
});

test('a request that never responds still times out', async () => {
  const client = new TrueForgeClient({
    requestTimeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  await assert.rejects(() => client.createSession('northvane'), /abort/i);
});

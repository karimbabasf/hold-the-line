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
  await assert.rejects(
    async () => {
      for await (const _ of client.streamTurn('s', [
        { type: 'user.message', content: 'hi' },
        { type: 'user.tool_approval', thread_id: 't', tool_call_id: 'c', approval: { status: 'allow' } },
      ])) { /* consume */ }
    },
    /must not mix/,
  );
});

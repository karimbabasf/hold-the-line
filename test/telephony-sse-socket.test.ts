import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { createLiveConsole } from '../src/telephony/live-console.ts';
import { createNodeHandler, createRouter } from '../src/telephony/router.ts';

/**
 * The one thing about `/sse` that cannot be tested without a socket: whether
 * a connected client stays connected.
 *
 * This is the defect that produced 0 bytes on `/sse` across a whole live
 * call. The SSE detach was wired to the request's `close` event, and Node
 * emits that on an IncomingMessage as soon as the body has been read to its
 * end, about 15ms in, whether or not the client is still there. Every console
 * client was dropped immediately and every later event went to an empty set.
 * The router's own tests cannot see this: it is a property of the Node
 * adapter around it, so it gets a real listener on an ephemeral port.
 */

const SECRET = 'socket-test-secret';

let server: Server;
let base: string;
const live = createLiveConsole({ ingestSecret: SECRET });

before(async () => {
  const handle = createRouter({
    chat: async () => new Response('{}'),
    secretMatches: () => true,
    consoleDir: '/nonexistent',
    agentName: 'northvane',
    sse: {
      attach: (sink, lastEventId) => { live.attach(sink, lastEventId); },
      detach: (sink) => { live.detach(sink); },
    },
    ingest: (authorization, body) => live.ingest(authorization, body),
  });
  server = createServer(createNodeHandler({ handle, maxBodyBytes: 64 * 1024 }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  // An SSE response is open by design, so a plain close() waits forever.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Opens `/sse` and collects what arrives, the way `curl -sN` would. */
async function openStream(): Promise<{ text: () => string; close: () => void }> {
  const controller = new AbortController();
  const response = await fetch(`${base}/sse`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  let text = '';
  void (async () => {
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        text += Buffer.from(chunk).toString('utf8');
      }
    } catch {
      // The abort below lands here. Nothing to do.
    }
  })();
  return { text: () => text, close: () => { controller.abort(); } };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

test('a client stays connected past the moment its request body is read', async () => {
  const stream = await openStream();
  await settle();

  live.emit({ type: 'call', status: 'started', claim_id: 'CLM-40218' });
  await settle();
  live.emit({ type: 'lane', name: 'state rules', tool: 'state_rules.get', status: 'pending' });
  await settle();

  const received = stream.text();
  stream.close();

  assert.ok(received.length > 0, '/sse produced 0 bytes: the client was dropped on connect');
  assert.match(received, /event: call/);
  assert.match(received, /event: lane/);
  assert.match(received, /CLM-40218/);
});

test('a POST to the ingest route reaches an already connected client', async () => {
  const stream = await openStream();
  await settle();
  live.emit({ type: 'call', status: 'started' });
  await settle();

  const response = await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      frames: [
        {
          at: Date.now(),
          event: {
            type: 'number', label: 'Net settlement, cash', value: 13481.12,
            from: 'computed', run_id: 'run-socket', unit: 'usd', spoken: false,
          },
        },
      ],
    }),
  });
  assert.equal(response.status, 202);
  await settle();

  const received = stream.text();
  stream.close();
  assert.match(received, /event: number/);
  assert.match(received, /run-socket/);
});

test('the ingest route refuses a POST with no token, over the wire', async () => {
  const response = await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ frames: [] }),
  });
  assert.equal(response.status, 401);
  await response.arrayBuffer();
});

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createRouter,
  type RouteRequest,
  type RouteResponse,
  type RouterDeps,
} from '../src/telephony/router.ts';

/**
 * The router used to live inside `createServer`'s callback, so nothing could
 * reach it without binding a port. A live probe on a spare port was the only
 * way to find that `/console?demo` 404'd, which is a bad way to find a bug
 * that a three-line test catches. It is a function over two small interfaces
 * now, and every case below runs with no socket anywhere.
 */

const CONSOLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'console');

interface Recorded {
  status: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
  /** Set by a test to stand in for a socket that has gone away. */
  dead: boolean;
}

function recorder(): { res: RouteResponse; out: Recorded } {
  const out: Recorded = { status: 0, headers: {}, body: '', ended: false, dead: false };
  const res: RouteResponse = {
    writable() {
      return !out.dead && !out.ended;
    },
    writeHead(status, headers) {
      out.status = status;
      out.headers = { ...(headers ?? {}) };
    },
    write(chunk) {
      out.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    },
    end(chunk) {
      if (chunk !== undefined) {
        out.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      }
      out.ended = true;
    },
  };
  return { res, out };
}

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    url: '/',
    headers: {},
    body: '',
    onClose: () => {},
    onAborted: () => {},
    ...overrides,
  };
}

function deps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    consoleDir: CONSOLE_DIR,
    agentName: 'northvane',
    secretMatches: () => true,
    chat: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    sse: { attach: () => {}, detach: () => {} },
    ...overrides,
  };
}

test('serves the console page when the path carries a query string', async () => {
  const handle = createRouter(deps());
  const { res, out } = recorder();

  await handle(request({ url: '/console?demo' }), res);

  assert.equal(out.status, 200);
  assert.equal(out.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(out.body, /<title>/i);
});

test('every documented console mode reaches the page, not the 404 branch', async () => {
  const handle = createRouter(deps());
  for (const url of ['/console', '/console?demo', '/console?speed=20', '/console?until=71000', '/console?live=1']) {
    const { res, out } = recorder();
    await handle(request({ url }), res);
    assert.equal(out.status, 200, `${url} did not reach the console`);
  }
});

test('strips types off a .ts console module on the way out', async () => {
  const handle = createRouter(deps());
  const { res, out } = recorder();

  await handle(request({ url: '/console/counters.ts' }), res);

  assert.equal(out.status, 200);
  assert.equal(out.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.ok(!out.body.includes('export interface NumberTally'), 'types survived the strip');
  assert.ok(out.body.includes('export function tally'), 'the code did not survive the strip');
});

test('refuses to serve a file outside the console directory', async () => {
  const handle = createRouter(deps());
  const { res, out } = recorder();

  await handle(request({ url: '/console/../../package.json' }), res);

  assert.ok(out.status === 403 || out.status === 404, `unexpected status ${out.status}`);
  assert.ok(!out.body.includes('hold-the-line'), 'served a file from outside the console directory');
});

test('health reports the agent it is bridging to', async () => {
  const handle = createRouter(deps({ agentName: 'northvane' }));
  const { res, out } = recorder();

  await handle(request({ url: '/health' }), res);

  assert.equal(out.status, 200);
  assert.deepEqual(JSON.parse(out.body), { ok: true, agent: 'northvane' });
});

test('an SSE client is attached on connect and detached when it goes away', async () => {
  const attached: RouteResponse[] = [];
  const detached: RouteResponse[] = [];
  const handle = createRouter(
    deps({
      sse: {
        attach: (sink) => { attached.push(sink); },
        detach: (sink) => { detached.push(sink); },
      },
    }),
  );

  let close = (): void => {};
  const { res, out } = recorder();
  await handle(request({ url: '/sse', onClose: (fn) => { close = fn; } }), res);

  assert.equal(out.status, 200);
  assert.equal(out.headers['content-type'], 'text/event-stream');
  assert.equal(out.ended, false, 'the SSE response must stay open');
  assert.deepEqual(attached, [res]);

  close();
  assert.deepEqual(detached, [res]);
});

test('the chat endpoint refuses an unauthenticated caller', async () => {
  let ran = false;
  const handle = createRouter(
    deps({
      secretMatches: () => false,
      chat: async () => { ran = true; return new Response('{}'); },
    }),
  );
  const { res, out } = recorder();

  await handle(request({ method: 'POST', url: '/v1/chat/completions', body: '{}' }), res);

  assert.equal(out.status, 401);
  assert.equal(ran, false, 'an unauthenticated body reached the harness');
});

test('the chat endpoint streams the body it is given back to the caller', async () => {
  let seenAuth: string | undefined;
  let seenBody = '';
  const handle = createRouter(
    deps({
      chat: async (req) => {
        seenAuth = req.headers.get('authorization') ?? undefined;
        seenBody = await req.text();
        return new Response('data: one\n\ndata: two\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    }),
  );
  const { res, out } = recorder();

  await handle(
    request({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer secret' },
      body: '{"messages":[]}',
    }),
    res,
  );

  assert.equal(out.status, 200);
  assert.equal(seenAuth, 'Bearer secret');
  assert.equal(seenBody, '{"messages":[]}');
  assert.equal(out.body, 'data: one\n\ndata: two\n\n');
  assert.equal(out.ended, true);
});

test('an unknown path is a 404', async () => {
  const handle = createRouter(deps());
  const { res, out } = recorder();

  await handle(request({ url: '/nope' }), res);

  assert.equal(out.status, 404);
});

// ---------------------------------------------------------------------------
// The hangup. A caller who puts the phone down has to reach the turn.

/** A response body that yields on demand, so a test can hang up mid-stream. */
function drip(): {
  body: ReadableStream<Uint8Array>;
  push: (s: string) => void;
  close: () => void;
  cancelled: () => unknown;
} {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let cancelledWith: unknown;
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel(reason) { cancelledWith = reason ?? 'cancelled'; },
  });
  return {
    body,
    push: (s) => { controller.enqueue(new TextEncoder().encode(s)); },
    close: () => { controller.close(); },
    cancelled: () => cancelledWith,
  };
}

test('a caller already gone reaches the endpoint as an aborted signal', async () => {
  // This is the half of the hangup path the signal covers: the socket was
  // already closed when the turn was dispatched, so the endpoint can refuse
  // to start one for somebody who is not there.
  //
  // It is deliberately NOT asserted that aborting later propagates through
  // the Request. It does not, reliably: a Request's signal is a follower of
  // the controller passed to it and stopped firing once the request object
  // was no longer referenced, which showed up live as a gate that stayed
  // held after the caller hung up. The reader cancel below is the path that
  // reaches a turn already in flight, and it has its own test.
  let seenSignal: AbortSignal | undefined;
  const handle = createRouter(
    deps({
      chat: async (req) => {
        seenSignal = req.signal;
        return new Response('data: one\n\n');
      },
    }),
  );
  const { res } = recorder();

  await handle(
    request({
      method: 'POST',
      url: '/v1/chat/completions',
      body: '{}',
      // Already gone by the time the route runs.
      onAborted: (fn) => { fn(); },
    }),
    res,
  );

  assert.ok(seenSignal, 'the endpoint was handed no signal to read');
  assert.equal(seenSignal.aborted, true, 'a turn was dispatched for a caller who had gone');
});

test('a hangup mid-stream cancels the response reader', async () => {
  const stream = drip();
  let hangup = (): void => {};
  const handle = createRouter(deps({ chat: async () => new Response(stream.body) }));
  const { res, out } = recorder();

  stream.push('data: one\n\n');
  const finished = handle(
    request({
      method: 'POST',
      url: '/v1/chat/completions',
      body: '{}',
      onAborted: (fn) => { hangup = fn; },
    }),
    res,
  );

  await new Promise((r) => setTimeout(r, 20));
  assert.match(out.body, /data: one/);

  // The caller puts the phone down while the agent is still talking.
  out.dead = true;
  hangup();
  await finished;

  assert.ok(stream.cancelled(), 'the stream was left running after the caller hung up');
});

test('a listener registered after the caller has gone still runs', async () => {
  // The chat route adds its reader-cancel listener AFTER awaiting the
  // harness, so a caller who hung up during that await has already closed
  // the socket by the time it is registered.
  const stream = drip();
  let aborted = false;
  const late: Array<() => void> = [];
  const handle = createRouter(deps({ chat: async () => new Response(stream.body) }));
  const { res, out } = recorder();

  out.dead = true;
  aborted = true;
  await handle(
    request({
      method: 'POST',
      url: '/v1/chat/completions',
      body: '{}',
      onAborted: (fn) => { if (aborted) fn(); else late.push(fn); },
    }),
    res,
  );

  assert.ok(stream.cancelled(), 'a turn kept running for a caller who was already gone');
});

test('a dead socket stops the write loop instead of writing into nothing', async () => {
  const stream = drip();
  stream.push('data: one\n\n');
  const handle = createRouter(deps({ chat: async () => new Response(stream.body) }));
  const { res, out } = recorder();

  const finished = handle(request({ method: 'POST', url: '/v1/chat/completions', body: '{}' }), res);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(out.body, /data: one/);

  // The socket dies, and the agent keeps talking. Everything after this
  // point has nowhere to go.
  out.dead = true;
  stream.push('data: two\n\n');
  stream.close();
  await finished;

  assert.ok(!out.body.includes('data: two'), 'wrote into a socket that was already gone');
  assert.equal(out.ended, false, 'a dead socket was ended anyway');
});

/**
 * The Telnyx status callback.
 *
 * This is the route that tells the console a phone was answered and, more
 * importantly, that a caller hung up: Telnyx holds one request per turn and
 * nothing in between, so an ordinary goodbye aborts nothing and the header
 * used to read ON CALL over a dead line until somebody else rang.
 *
 * It authenticates on a query token because Telnyx sends the callback itself
 * and there is nowhere to configure a header on it.
 */
test('the Telnyx status callback reaches the handler with a good token', async () => {
  const seen: string[] = [];
  const handle = createRouter(
    deps({
      secretMatches: (v) => v === 'sekret',
      telnyxStatus: (body) => {
        seen.push(body);
        return { status: 200, body: { ok: true } };
      },
    }),
  );
  const { res, out } = recorder();

  await handle(
    request({
      method: 'POST',
      url: '/telnyx/status?k=sekret',
      body: 'CallStatus=completed&From=%2B14155550101',
    }),
    res,
  );

  assert.equal(out.status, 200);
  assert.deepEqual(seen, ['CallStatus=completed&From=%2B14155550101']);
});

test('the status callback is rejected without the token', async () => {
  let called = false;
  const handle = createRouter(
    deps({
      secretMatches: (v) => v === 'sekret',
      telnyxStatus: () => {
        called = true;
        return { status: 200, body: { ok: true } };
      },
    }),
  );

  for (const url of ['/telnyx/status', '/telnyx/status?k=wrong']) {
    const { res, out } = recorder();
    await handle(request({ method: 'POST', url, body: 'CallStatus=completed' }), res);
    assert.equal(out.status, 401, `${url} was not rejected`);
  }
  assert.equal(called, false, 'an unauthenticated callback reached the handler');
});

test('the status route 404s when it is not wired, and on the wrong method', async () => {
  const unwired = createRouter(deps());
  const a = recorder();
  await unwired(request({ method: 'POST', url: '/telnyx/status?k=x' }), a.res);
  assert.equal(a.out.status, 404);

  const wired = createRouter(deps({ telnyxStatus: () => ({ status: 200, body: {} }) }));
  const b = recorder();
  await wired(request({ method: 'GET', url: '/telnyx/status?k=x' }), b.res);
  assert.equal(b.out.status, 404);
});

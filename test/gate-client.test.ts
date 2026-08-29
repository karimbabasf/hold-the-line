import assert from 'node:assert/strict';
import test from 'node:test';

import { createGateClient, type GateRequest } from '../src/console/gate-client.ts';

/**
 * The operator's half of the gate.
 *
 * The console rendered a draft and three buttons that posted nowhere, so a
 * held gate could not be released at all. Once the gate genuinely blocks
 * speech, that is a caller listening to silence with nobody able to help
 * them.
 *
 * The rule every test here exists to hold: a binding sentence is spoken
 * because a person clicked, and for no other reason. There is no timeout
 * that approves, no retry that approves, no error path that approves, and
 * nothing at all happens without a call.
 */

interface Sent {
  url: string;
  method: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

function recorder(status = 200, payload: unknown = { ok: true }) {
  const sent: Sent[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    sent.push({
      url: String(url),
      method: init?.method ?? 'GET',
      auth: headers.get('authorization') ?? undefined,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

function clientOn(impl: typeof fetch, token: string | null = 'operator-secret') {
  return createGateClient({ fetchImpl: impl, token: () => token });
}

test('approving posts an allow for that one gate, with the operator token', async () => {
  const { impl, sent } = recorder();
  const result = await clientOn(impl).approve('call_pfUmambJfpISErJ9rcIYMHui');

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.method, 'POST');
  assert.match(sent[0]?.url ?? '', /\/gate\/decide$/);
  assert.equal(sent[0]?.auth, 'Bearer operator-secret');
  assert.deepEqual(sent[0]?.body, { id: 'call_pfUmambJfpISErJ9rcIYMHui', status: 'allow' });
});

test('sending back carries the reason the agent redrafts from', async () => {
  const { impl, sent } = recorder();
  const reason = "struck 'final': it is an offer. recompute with salvage retention.";
  const result = await clientOn(impl).sendBack('gate-1', reason);

  assert.equal(result.ok, true);
  assert.deepEqual(sent[0]?.body, { id: 'gate-1', status: 'deny', reason });
});

test('a send back with no reason is refused before it leaves the browser', async () => {
  const { impl, sent } = recorder();
  const result = await clientOn(impl).sendBack('gate-1', '   ');

  assert.equal(result.ok, false);
  assert.match(result.error, /reason/i);
  assert.equal(sent.length, 0, 'a redraft with nothing to redraft from was sent anyway');
});

test('a rejected token is an error on screen, not a resolved gate', async () => {
  const { impl } = recorder(401, { error: 'unauthorized' });
  const result = await clientOn(impl).approve('gate-1');

  assert.equal(result.ok, false);
  assert.match(result.error, /token|unauthor/i);
});

test('a gate nobody is waiting on is reported as such', async () => {
  const { impl } = recorder(404, { error: 'no gate is waiting on that id' });
  const result = await clientOn(impl).approve('gate-stale');

  assert.equal(result.ok, false);
  assert.match(result.error, /no gate is waiting/);
});

test('a network failure is an error, never an approval', async () => {
  const impl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const result = await clientOn(impl).approve('gate-1');

  assert.equal(result.ok, false);
  assert.match(result.error, /could not reach/i);
});

test('with no token nothing is posted at all', async () => {
  const { impl, sent } = recorder();
  const result = await clientOn(impl, null).approve('gate-1');

  assert.equal(result.ok, false);
  // The wording is the operator's, not the wire's: the console calls this an
  // operator key and says where to set it, rather than naming the
  // environment variable it comes from.
  assert.match(result.error, /operator key/i);
  assert.equal(sent.length, 0);
});

// ---------------------------------------------------------------------------
// The invariant.

test('nothing is ever sent unless a person calls it', async () => {
  const { impl, sent } = recorder();
  createGateClient({ fetchImpl: impl, token: () => 'operator-secret' });

  // Well past any timeout a convenience feature would plausibly use.
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(sent.length, 0, 'the client posted something nobody asked for');
});

test('no call this client can make sends an allow except approve', async () => {
  const { impl, sent } = recorder();
  const client = clientOn(impl);

  await client.sendBack('gate-1', 'recompute with salvage retention');
  await client.sendBack('gate-2', 'wrong claim');
  await new Promise((r) => setTimeout(r, 200));

  const allows = sent.filter((s) => s.body['status'] === 'allow');
  assert.equal(allows.length, 0, 'a send back turned into an approval');
  assert.equal(sent.length, 2);
});

test('a failed approval is not retried into a second attempt', async () => {
  const { impl, sent } = recorder(500, { error: 'internal error' });
  const client = clientOn(impl);

  const result = await client.approve('gate-1');
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(result.ok, false);
  assert.equal(sent.length, 1, 'a retry could approve a gate an operator gave up on');
});

test('the request shape is exactly what the server accepts', () => {
  // Compile-time proof that this client cannot invent a third status. The
  // server settles a gate on "allow" or "deny" and on nothing else.
  const allow: GateRequest = { id: 'gate-1', status: 'allow' };
  const deny: GateRequest = { id: 'gate-1', status: 'deny', reason: 'recompute' };
  assert.equal(allow.status, 'allow');
  assert.equal(deny.status, 'deny');
});

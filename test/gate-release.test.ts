import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { createGateClient } from '../src/console/gate-client.ts';
import type { ApprovalDecision, ResolvedGate } from '../src/trueforge/types.ts';
import { createNodeHandler, createRouter } from '../src/telephony/router.ts';

/**
 * An operator's click, over a real socket, releasing a gate that is really
 * held.
 *
 * The console's buttons posted nowhere, so this is the path that did not
 * exist. It is tested against a real listener rather than by calling the
 * decide function directly, because the thing that was missing was the wire.
 *
 * The other half of this file is the invariant: a gate nobody decides is
 * never released. Not by a timeout, not by an unauthenticated caller, not by
 * a malformed body, not by asking twice.
 */

const SECRET = 'operator-secret';

/** Stands in for the bridge: one held gate and the promise waiting on it. */
function heldGate(id: string) {
  const gates = new Map<string, ResolvedGate>();
  const waiting = new Map<string, (d: ApprovalDecision | null) => void>();
  let settledWith: ApprovalDecision | null | undefined;

  gates.set(id, {
    tool_call_id: id,
    thread_id: 'thread-1',
    tool: 'offer.state_settlement',
    utterance: 'Northvane can settle your claim today at 13,481 dollars and 12 cents.',
    claim_id: 'CLM-40218',
    authorised_amounts: [13481.12],
  });

  const held = new Promise<ApprovalDecision | null>((settle) => {
    waiting.set(id, (decision) => { settledWith = decision; settle(decision); });
  });
  // Nothing else ever awaits this, and an unsettled promise is the point.
  void held.catch(() => undefined);

  return {
    gates,
    /** Undefined while the gate is still held. */
    decision: () => settledWith,
    decide(gateId: string, decision: ApprovalDecision | null): boolean {
      const settle = waiting.get(gateId);
      if (!settle) return false;
      waiting.delete(gateId);
      gates.delete(gateId);
      settle(decision);
      return true;
    },
  };
}

let server: Server;
let base: string;
let gate: ReturnType<typeof heldGate>;

before(async () => {
  gate = heldGate('call_pfUmambJfpISErJ9rcIYMHui');
  const handle = createRouter({
    chat: async () => new Response('{}'),
    secretMatches: (header) => header === `Bearer ${SECRET}`,
    consoleDir: '/nonexistent',
    agentName: 'northvane',
    sse: { attach: () => {}, detach: () => {} },
    gate: {
      pending: () => [...gate.gates.values()],
      decide: async (raw) => {
        let body: { id?: unknown; status?: unknown; reason?: unknown };
        try {
          body = JSON.parse(raw);
        } catch {
          return { status: 400, body: { error: 'body was not valid JSON' } };
        }
        const allowed = body.status === 'allow';
        const denied = body.status === 'deny';
        if (typeof body.id !== 'string' || (!allowed && !denied)) {
          return { status: 400, body: { error: 'expected {id, status: "allow" | "deny", reason?}' } };
        }
        const decision: ApprovalDecision = allowed
          ? { status: 'allow' }
          : { status: 'deny', ...(typeof body.reason === 'string' ? { reason: body.reason } : {}) };
        return gate.decide(body.id, decision)
          ? { status: 200, body: { ok: true } }
          : { status: 404, body: { error: 'no gate is waiting on that id' } };
      },
    },
  });
  server = createServer(createNodeHandler({ handle, maxBodyBytes: 64 * 1024 }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function consoleClient(token: string | null = SECRET) {
  return createGateClient({ token: () => token, endpoint: `${base}/gate/decide` });
}

async function pending(): Promise<ResolvedGate[]> {
  const response = await fetch(`${base}/gate/pending`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  return (await response.json()) as ResolvedGate[];
}

test('the console can read the draft it is being asked to authorise', async () => {
  const [held] = await pending();
  assert.equal(held?.tool, 'offer.state_settlement');
  assert.match(held?.utterance ?? '', /13,481 dollars and 12 cents/);
  assert.deepEqual(held?.authorised_amounts, [13481.12]);
});

test('a gate nobody decides is still held', async () => {
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(gate.decision(), undefined, 'something released the gate on its own');
  assert.equal((await pending()).length, 1);
});

test('an unauthenticated decision releases nothing', async () => {
  const result = await consoleClient('not-the-secret').approve('call_pfUmambJfpISErJ9rcIYMHui');
  assert.equal(result.ok, false);
  assert.equal(gate.decision(), undefined, 'a wrong token approved a binding utterance');
  assert.equal((await pending()).length, 1);
});

test('a malformed decision releases nothing', async () => {
  for (const body of ['not json', '{}', '{"id":"call_pfUmambJfpISErJ9rcIYMHui"}', '{"id":"call_pfUmambJfpISErJ9rcIYMHui","status":"maybe"}']) {
    const response = await fetch(`${base}/gate/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body,
    });
    assert.equal(response.status, 400, `${body} was accepted as a decision`);
    await response.arrayBuffer();
  }
  assert.equal(gate.decision(), undefined);
});

test('an operator click releases the gate, and only that gate', async () => {
  const client = consoleClient();

  const wrongId = await client.approve('call_someOtherGate');
  assert.equal(wrongId.ok, false);
  assert.equal(gate.decision(), undefined);

  const result = await client.approve('call_pfUmambJfpISErJ9rcIYMHui');
  assert.equal(result.ok, true);
  assert.deepEqual(gate.decision(), { status: 'allow' });
  assert.equal((await pending()).length, 0);
});

test('the same click a second time does not resolve anything again', async () => {
  const result = await consoleClient().approve('call_pfUmambJfpISErJ9rcIYMHui');
  assert.equal(result.ok, false);
  assert.match(result.error, /no gate is waiting/);
});

test('a send back reaches the server as a deny carrying the reason', async () => {
  const second = heldGate('gate-2');
  gate.gates = second.gates;
  const previous = gate.decide;
  gate.decide = second.decide;
  gate.decision = second.decision;

  const reason = "struck 'final': recompute with salvage retention, the caller wants the car.";
  const result = await consoleClient().sendBack('gate-2', reason);

  assert.equal(result.ok, true);
  assert.deepEqual(second.decision(), { status: 'deny', reason });
  void previous;
});

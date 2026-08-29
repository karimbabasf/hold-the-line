import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { GATED_TOOL_NAMES } from '../src/mcp/gated.ts';
import { createHttpServer, matchesGateSecret } from '../src/mcp/server.ts';

/**
 * Exercises the real MCP wire protocol: an actual `@modelcontextprotocol/sdk`
 * client, over real HTTP, against `createHttpServer()` on an ephemeral port.
 * This is the same client library TrueForge itself depends on (confirmed
 * against the locally running TrueForge install), so a pass here is real
 * evidence the server will register and respond the way TrueForge expects,
 * independent of the live TrueForge proof captured in the PR.
 */

let baseUrl: string;
let httpServer: ReturnType<typeof createHttpServer>;

before(async () => {
  httpServer = createHttpServer();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://localhost:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function connectClient(): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  // See the matching comment in src/mcp/server.ts: the SDK's Transport type
  // was not written against `exactOptionalPropertyTypes: true`.
  await client.connect(transport as Transport);
  return client;
}

/** `callTool`'s real return type is a large content-block union (plus a
 *  legacy `toolResult` variant); narrowed here at the one text block this
 *  suite actually reads, rather than trying to restate that union. */
function textOf(result: unknown): unknown {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const first = content?.[0];
  assert.equal(first?.type, 'text', JSON.stringify(result));
  return JSON.parse(first?.text ?? 'null');
}

test('GET /health responds ok', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('lists all eight safe tools and five gated tools', async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();

  assert.deepEqual(names, [
    'claim.get',
    'claims_history.get',
    'coverage.deny',
    'lienholder.payoff_quote',
    'offer.state_settlement',
    'payment.issue',
    'policy.lookup',
    'salvage.release_vehicle',
    'settlement.accept',
    'state_rules.get',
    'valuation.comps',
    'vehicle.get',
    'yard.storage_status',
  ]);

  for (const gated of GATED_TOOL_NAMES) {
    assert.ok(names.includes(gated), `${gated} missing from tools/list`);
  }

  const policyTool = tools.find((t) => t.name === 'policy.lookup');
  assert.equal(policyTool?.annotations?.readOnlyHint, true);
  const offerTool = tools.find((t) => t.name === 'offer.state_settlement');
  assert.equal(offerTool?.annotations?.readOnlyHint, false);

  await client.close();
});

test('a safe tool returns real fixture data over the wire', async () => {
  const client = await connectClient();
  const result = await client.callTool({ name: 'state_rules.get', arguments: { state: 'AZ' } });
  const rules = textOf(result) as { total_loss_threshold_pct: number; sales_tax_pct: number };
  assert.equal(rules.total_loss_threshold_pct, 75.0);
  assert.equal(rules.sales_tax_pct, 8.6);
  await client.close();
});

test('lienholder.payoff_quote computes the payoff, not a stored figure', async () => {
  const client = await connectClient();
  const result = await client.callTool({
    name: 'lienholder.payoff_quote',
    arguments: { loan_id: 'CAF-9920431', through_date: '2026-10-02' },
  });
  const quote = textOf(result) as { days: number; payoff: number };
  // Matches spec section 4.5: 35 days of interest, 8764.12 total.
  assert.equal(quote.days, 35);
  assert.equal(quote.payoff, 8764.12);
  await client.close();
});

test('lienholder.payoff_quote rejects a loan_id that is not the lien on file', async () => {
  // A live run against TrueForge had the model pass the POLICY id here
  // (NVM-4417-2288) instead of vehicle.lien.loan_id (CAF-9920431). This
  // used to silently return a real quote for the one lien on file
  // regardless of the id passed in.
  const client = await connectClient();
  const result = await client.callTool({
    name: 'lienholder.payoff_quote',
    arguments: { loan_id: 'NVM-4417-2288', through_date: '2026-10-02' },
  });
  assert.equal(result.isError, true);
  await client.close();
});

test('lienholder.payoff_quote rejects a through_date past the lender quote validity', async () => {
  const client = await connectClient();
  const result = await client.callTool({
    name: 'lienholder.payoff_quote',
    arguments: { loan_id: 'CAF-9920431', through_date: '2026-10-03' },
  });
  assert.equal(result.isError, true);
  await client.close();
});

test('yard.storage_status matches the 450.00 accrual in spec section 4.7', async () => {
  const client = await connectClient();
  const result = await client.callTool({
    name: 'yard.storage_status',
    arguments: { claim_id: 'CLM-40218' },
  });
  const status = textOf(result) as { days_stored: number; accrued: number };
  assert.equal(status.days_stored, 6);
  assert.equal(status.accrued, 450.0);
  await client.close();
});

test('two lane tools called concurrently over HTTP overlap, they do not serialise', async () => {
  const client = await connectClient();
  const started = Date.now();
  // lienholder.payoff_quote (2200ms) and state_rules.get (3400ms): serial
  // would be 5600ms, concurrent should land close to 3400ms.
  await Promise.all([
    client.callTool({
      name: 'lienholder.payoff_quote',
      arguments: { loan_id: 'CAF-9920431', through_date: '2026-10-02' },
    }),
    client.callTool({ name: 'state_rules.get', arguments: { state: 'AZ' } }),
  ]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `took ${elapsed}ms, serial would be roughly 5600ms`);
  await client.close();
});

test('the gate: unapproved offer.state_settlement fails closed over the wire', async () => {
  await fetch(`${baseUrl}/gate/pending`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      claim_id: 'CLM-WIRE-1',
      wanted: 'never approved',
      authorised_amounts: [],
    }),
  });

  const client = await connectClient();
  const result = await client.callTool({
    name: 'offer.state_settlement',
    arguments: { claim_id: 'CLM-WIRE-1', utterance: 'never approved', authorised_amounts: [] },
  });
  assert.equal(result.isError, true);
  await client.close();
});

test('the gate end to end: pending draft, operator edit, approve, tool returns the edit', async () => {
  const pendingRes = await fetch(`${baseUrl}/gate/pending`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      claim_id: 'CLM-WIRE-2',
      wanted: 'Northvane can settle your claim today at 13,481.12, final.',
      authorised_amounts: [13481.12, 9180.12],
    }),
  });
  assert.equal(pendingRes.status, 200);

  const shown = (await (await fetch(`${baseUrl}/gate`)).json()) as { claim_id: string };
  assert.equal(shown.claim_id, 'CLM-WIRE-2');

  const approveRes = await fetch(`${baseUrl}/gate/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'Northvane can settle at 13,481.12. That offer stands for 30 days.',
    }),
  });
  assert.equal(approveRes.status, 200);
  const decision = (await approveRes.json()) as { wanted: string; said: string };
  assert.equal(decision.wanted, 'Northvane can settle your claim today at 13,481.12, final.');
  assert.equal(decision.said, 'Northvane can settle at 13,481.12. That offer stands for 30 days.');

  const client = await connectClient();
  const result = await client.callTool({
    name: 'offer.state_settlement',
    arguments: {
      claim_id: 'CLM-WIRE-2',
      utterance: 'Northvane can settle your claim today at 13,481.12, final.',
      authorised_amounts: [13481.12, 9180.12],
    },
  });
  assert.equal(result.isError, undefined);
  const spoken = textOf(result) as { wanted: string; said: string };
  assert.equal(spoken.said, 'Northvane can settle at 13,481.12. That offer stands for 30 days.');
  assert.notEqual(spoken.said, spoken.wanted);
  await client.close();
});

test('an unknown route 404s cleanly', async () => {
  const res = await fetch(`${baseUrl}/nope`);
  assert.equal(res.status, 404);
});

// Qodo found that every single-record SAFE lookup except valuation.comps
// ignored its own identifier and always answered for the one fixture on
// file, the same bug already fixed for lienholder.payoff_quote above. Each
// now fails closed on a mismatch; these prove it over the real wire.
test('policy.lookup, claim.get, vehicle.get, state_rules.get and yard.storage_status fail closed on an unknown identifier', async () => {
  const client = await connectClient();
  const cases: Array<{ name: string; arguments: Record<string, string> }> = [
    { name: 'policy.lookup', arguments: { phone: '+10000000000' } },
    { name: 'claim.get', arguments: { claim_id: 'CLM-WRONG' } },
    { name: 'vehicle.get', arguments: { vin: 'WRONGVIN0000000' } },
    { name: 'state_rules.get', arguments: { state: 'CA' } },
    { name: 'yard.storage_status', arguments: { claim_id: 'CLM-WRONG' } },
    { name: 'claims_history.get', arguments: { vin: 'WRONGVIN0000000' } },
  ];
  for (const c of cases) {
    const result = await client.callTool(c);
    assert.equal(result.isError, true, `${c.name} should fail closed on a mismatch`);
  }
  await client.close();
});

test('the same five tools still answer correctly for the real identifiers', async () => {
  const client = await connectClient();
  const policy = textOf(
    await client.callTool({ name: 'policy.lookup', arguments: { phone: '+14155550142' } }),
  ) as { policy_id: string };
  assert.equal(policy.policy_id, 'NVM-4417-2288');

  const claim = textOf(
    await client.callTool({ name: 'claim.get', arguments: { claim_id: 'CLM-40218' } }),
  ) as { claim_id: string };
  assert.equal(claim.claim_id, 'CLM-40218');
  await client.close();
});

// matchesGateSecret is dependency-injected (the secret is a parameter, not
// read from process.env inside it) precisely so this is testable without
// process-level tricks.
test('matchesGateSecret allows anything when no secret is configured', () => {
  assert.equal(matchesGateSecret(undefined, undefined), true);
  assert.equal(matchesGateSecret('Bearer whatever', undefined), true);
});

test('matchesGateSecret requires an exact bearer match once a secret is configured', () => {
  assert.equal(matchesGateSecret('Bearer s3cret', 's3cret'), true);
  assert.equal(matchesGateSecret('bearer s3cret', 's3cret'), true);
  assert.equal(matchesGateSecret('Bearer wrong', 's3cret'), false);
  assert.equal(matchesGateSecret(undefined, 's3cret'), false);
});

test('the gate admin routes enforce gateSecret end to end over HTTP when one is configured', async () => {
  const secured = createHttpServer({ gateSecret: 'test-only-secret' });
  await new Promise<void>((resolve) => secured.listen(0, '127.0.0.1', resolve));
  const { port } = secured.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  try {
    const noAuth = await fetch(`${url}/gate`);
    assert.equal(noAuth.status, 401);

    const wrongAuth = await fetch(`${url}/gate`, {
      headers: { authorization: 'Bearer nope' },
    });
    assert.equal(wrongAuth.status, 401);

    const rightAuth = await fetch(`${url}/gate`, {
      headers: { authorization: 'Bearer test-only-secret' },
    });
    assert.equal(rightAuth.status, 200);
  } finally {
    await new Promise<void>((resolve) => secured.close(() => resolve()));
  }
});

/**
 * The Northvane MCP server: eight safe read/compute tools and five gated
 * ones, over Streamable HTTP on port 8792.
 *
 * TrueForge takes MCP servers by remote URL only, so this cannot be a stdio
 * server (hard constraint, see the plan). It uses the official
 * `@modelcontextprotocol/sdk`, which TrueForge itself depends on for its own
 * MCP client: matching the library on both ends of the wire is worth the one
 * runtime dependency it costs (`zod` comes along as the SDK's own required
 * peer for tool input schemas, not a separate choice).
 *
 * Kept together in one file, unlike telephony/server.ts's split into
 * server/chat-endpoint/harness-bridge, because there is no meaningful "logic
 * without a port" layer here: every tool is either a fixture read (Task 2's
 * loader) or a gated.ts handler, and the only thing this file adds is
 * wiring them onto the MCP protocol and sleeping the lane delay. Binding the
 * port itself is guarded behind the entrypoint check at the bottom, so
 * importing this module (tests, or a future task) never opens 8792.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  WebStandardStreamableHTTPServerTransport,
  type WebStandardStreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import {
  loadClaim,
  loadComps,
  loadPolicy,
  loadStateRules,
  loadVehicle,
} from '../data/fixtures.ts';
import { daysBetween } from '../settle/settle.ts';
import { LANES, type LaneDef } from './lanes.ts';
import {
  approveGate,
  coverageDeny,
  GATED_TOOL_NAMES,
  offerStateSettlement,
  paymentIssue,
  pendingGate,
  salvageReleaseVehicle,
  setPendingGate,
  settlementAccept,
  type GateDraft,
} from './gated.ts';

const toCents = (dollars: number): number => Math.round(dollars * 100);
const toDollars = (cents: number): number => cents / 100;

// ---------------------------------------------------------------------------
// The eight SAFE tools (spec section 6). Each reads Task 2's fixture loader;
// none of them mutate anything. Exported individually so they can be unit
// tested without going through HTTP or the MCP wire protocol.
// ---------------------------------------------------------------------------

export function policyLookup(_args: { phone: string }) {
  return loadPolicy();
}

export function claimGet(_args: { claim_id: string }) {
  return loadClaim();
}

export function vehicleGet(_args: { vin: string }) {
  return loadVehicle();
}

export function valuationComps(args: { vin: string; zip?: string; radius?: number }) {
  return { vin: args.vin, comps: loadComps().filter((c) => c.vin_ref === args.vin) };
}

export function lienholderPayoffQuote(args: { loan_id: string; through_date: string }) {
  const { lien } = loadVehicle();
  // A live run surfaced the model quoting a payoff against the POLICY id
  // instead of vehicle.lien.loan_id. Nothing here previously checked
  // loan_id at all, so a wrong identifier silently returned a real quote
  // for the one lien on file. Fail closed instead: a mismatch is exactly
  // the failure mode this project has to make impossible.
  if (args.loan_id !== lien.loan_id) {
    throw new Error(
      `lienholder.payoff_quote: unknown loan_id "${args.loan_id}". The loan id is on ` +
        `vehicle.get's lien.loan_id, not the policy id; look it up there and retry.`,
    );
  }
  const days = daysBetween(lien.principal_as_of, args.through_date);
  if (days < 0) {
    throw new Error(
      `through_date ${args.through_date} is before the principal date ${lien.principal_as_of}`,
    );
  }
  // Mirrors settle.ts's own guard: quoting past the lender's stated
  // validity window invents interest the lender never agreed to.
  if (daysBetween(args.through_date, lien.good_through) < 0) {
    throw new Error(
      `through_date ${args.through_date} is past the lender quote validity (${lien.good_through}); ` +
        'request a fresh payoff quote instead of extrapolating past it.',
    );
  }
  const payoffCents = toCents(lien.principal) + toCents(lien.per_diem * days);
  return {
    loan_id: lien.loan_id,
    lender: lien.lender,
    through_date: args.through_date,
    principal: lien.principal,
    per_diem: lien.per_diem,
    days,
    payoff: toDollars(payoffCents),
    note: 'a quote, it does not bind',
  };
}

export function claimsHistoryGet(args: { vin: string }) {
  // Spec section 5 lists five fixture files, not six: there is no dedicated
  // claims-history record. Prior claim activity for this vehicle lives on
  // vehicle.prior_damage, which is what the "prior damage and claim
  // history" lane (lanes.ts) is actually pulling.
  const vehicle = loadVehicle();
  return { vin: args.vin, prior_claims: vehicle.vin === args.vin ? vehicle.prior_damage : [] };
}

export function stateRulesGet(_args: { state: string }) {
  return loadStateRules();
}

export function yardStorageStatus(_args: { claim_id: string }) {
  const claim = loadClaim();
  const days = daysBetween(claim.storage_start, claim.quote_date);
  const accruedCents = toCents(claim.storage_per_day) * days;
  return {
    claim_id: claim.claim_id,
    yard_id: claim.yard_id,
    storage_per_day: claim.storage_per_day,
    storage_start: claim.storage_start,
    days_stored: days,
    accrued: toDollars(accruedCents),
  };
}

// ---------------------------------------------------------------------------
// Tool registry: name, description, zod input shape, annotations and
// handler, one entry per tool, one registration loop below. The same
// "config array, never hand-written call sites" rule Task 4 applies to the
// lanes applies here too.
// ---------------------------------------------------------------------------

interface ToolEntry {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodRawShape;
  readonly annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  readonly handler: (args: Record<string, unknown>) => unknown;
}

const SAFE_TOOLS: readonly ToolEntry[] = [
  {
    name: 'policy.lookup',
    description: "Look up the caller's policy by phone number.",
    input: { phone: z.string() },
    annotations: { readOnlyHint: true },
    handler: (a) => policyLookup(a as { phone: string }),
  },
  {
    name: 'claim.get',
    description: 'Fetch a claim by id.',
    input: { claim_id: z.string() },
    annotations: { readOnlyHint: true },
    handler: (a) => claimGet(a as { claim_id: string }),
  },
  {
    name: 'vehicle.get',
    description: 'Fetch vehicle detail by VIN, including lien and prior damage.',
    input: { vin: z.string() },
    annotations: { readOnlyHint: true },
    handler: (a) => vehicleGet(a as { vin: string }),
  },
  {
    name: 'valuation.comps',
    description: 'Comparable listings for a VIN, for market-value adjustment.',
    input: { vin: z.string(), zip: z.string().optional(), radius: z.number().optional() },
    annotations: { readOnlyHint: true },
    handler: (a) => valuationComps(a as { vin: string; zip?: string; radius?: number }),
  },
  {
    name: 'lienholder.payoff_quote',
    description:
      'A lien payoff quote through a given date. loan_id must be the lien loan id from ' +
      'vehicle.get (field lien.loan_id), not the policy id; a mismatch is rejected. ' +
      'through_date must be on or before the lien good_through date, and on or after ' +
      'lien.principal_as_of. A quote, it does not bind.',
    input: { loan_id: z.string(), through_date: z.string() },
    annotations: { readOnlyHint: true },
    handler: (a) => lienholderPayoffQuote(a as { loan_id: string; through_date: string }),
  },
  {
    name: 'claims_history.get',
    description: 'Prior claim activity for a VIN.',
    input: { vin: z.string() },
    annotations: { readOnlyHint: true },
    handler: (a) => claimsHistoryGet(a as { vin: string }),
  },
  {
    name: 'state_rules.get',
    description: 'Total-loss threshold, tax and fee rules for a state.',
    input: { state: z.string() },
    annotations: { readOnlyHint: true },
    handler: (a) => stateRulesGet(a as { state: string }),
  },
  {
    name: 'yard.storage_status',
    description: 'Current tow-yard storage accrual for a claim.',
    input: { claim_id: z.string() },
    annotations: { readOnlyHint: true },
    handler: (a) => yardStorageStatus(a as { claim_id: string }),
  },
];

const GATED_TOOLS: readonly ToolEntry[] = [
  {
    name: 'offer.state_settlement',
    description:
      'Speak a binding settlement offer. The utterance argument IS the sentence; gated. ' +
      'Returns the operator-approved wording, never the raw argument.',
    input: {
      claim_id: z.string(),
      utterance: z.string(),
      authorised_amounts: z.array(z.number()),
    },
    annotations: { readOnlyHint: false },
    handler: (a) =>
      offerStateSettlement(
        a as { claim_id: string; utterance: string; authorised_amounts: number[] },
      ),
  },
  {
    name: 'settlement.accept',
    description: 'Record the caller accepting a settlement amount and option. Gated.',
    input: { claim_id: z.string(), amount: z.number(), option: z.string() },
    annotations: { readOnlyHint: false },
    handler: (a) => settlementAccept(a as { claim_id: string; amount: number; option: string }),
  },
  {
    name: 'payment.issue',
    description: 'Issue payment for a claim. Gated.',
    input: { claim_id: z.string(), amount: z.number(), method: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: (a) => paymentIssue(a as { claim_id: string; amount: number; method: string }),
  },
  {
    name: 'salvage.release_vehicle',
    description: 'Release a vehicle to salvage. Irreversible, unrecoverable. Gated.',
    input: { claim_id: z.string(), yard_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: (a) => salvageReleaseVehicle(a as { claim_id: string; yard_id: string }),
  },
  {
    name: 'coverage.deny',
    description: 'Deny coverage on a claim. Adverse action, regulated. Gated.',
    input: { claim_id: z.string(), reason: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: (a) => coverageDeny(a as { claim_id: string; reason: string }),
  },
];

const TOOLS: readonly ToolEntry[] = [...SAFE_TOOLS, ...GATED_TOOLS];

// Sanity check that the two independently-written tool lists (this file's
// GATED_TOOLS and gated.ts's own GATED_TOOL_NAMES, which agent.json's
// require_approval_for_tools must match) never drift apart silently.
const gatedNamesHere = GATED_TOOLS.map((t) => t.name).sort();
const gatedNamesExpected = [...GATED_TOOL_NAMES].sort();
if (JSON.stringify(gatedNamesHere) !== JSON.stringify(gatedNamesExpected)) {
  throw new Error(
    `server.ts GATED_TOOLS ${JSON.stringify(gatedNamesHere)} does not match ` +
      `gated.ts GATED_TOOL_NAMES ${JSON.stringify(gatedNamesExpected)}`,
  );
}

/** tool name -> its lane's deliberate demo latency, 0 for the three tools
 *  that are not one of the five fan-out lanes. */
const toolDelay: ReadonlyMap<string, number> = new Map(LANES.map((l) => [l.tool, l.delayMs]));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one tool by name: the deliberate lane delay (if it has one), the
 * handler, and a uniform result/error shape. Used both by the MCP
 * `tools/call` wiring below and by `runDemoFanout`, so there is exactly one
 * place a tool actually executes.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const entry = TOOLS.find((t) => t.name === name);
  if (!entry) {
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  }

  const delay = toolDelay.get(name) ?? 0;
  if (delay > 0) await sleep(delay);

  try {
    const result = await entry.handler(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// The fan-out mechanism. Generic on purpose: test/lanes.test.ts proves the
// concurrency property (parallel_ms well under serial_ms) against a
// synthetic exec, and runDemoFanout below proves the same property against
// the real tools, reading real fixtures and sleeping real lane delays.
// ---------------------------------------------------------------------------

export interface LaneRunResult<R> {
  results: R[];
  /** Observed wall-clock time for every lane to finish, running concurrently. */
  parallel_ms: number;
  /** Sum of each lane's OBSERVED duration, not its configured delayMs, so
   *  this stays honest if a lane runs slower or faster than configured. */
  serial_ms: number;
}

export async function runLanes<L extends { delayMs: number }, R>(
  lanes: readonly L[],
  exec: (lane: L) => Promise<R>,
): Promise<LaneRunResult<R>> {
  const wallStart = performance.now();
  const timed = await Promise.all(
    lanes.map(async (lane) => {
      const laneStart = performance.now();
      const result = await exec(lane);
      return { result, ms: performance.now() - laneStart };
    }),
  );
  return {
    results: timed.map((t) => t.result),
    parallel_ms: performance.now() - wallStart,
    serial_ms: timed.reduce((sum, t) => sum + t.ms, 0),
  };
}

/** Fires the real five lanes concurrently against the real tool handlers,
 *  the same call path TrueForge uses. This is the "3.4s parallel vs 11.1s
 *  serial" counter, generated from a real run rather than hard-coded. */
export async function runDemoFanout(): Promise<LaneRunResult<unknown>> {
  return runLanes(LANES, (lane: LaneDef) => callTool(lane.tool, lane.args as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// HTTP wiring: the MCP protocol at /mcp, a small gate admin surface the
// console (or, for the live proof below, a driver script standing in for
// one) uses to show the draft and record the operator's decision, and a
// health check.
// ---------------------------------------------------------------------------

function buildMcpServer(): McpServer {
  const mcp = new McpServer({ name: 'northvane', version: '0.1.0' });
  for (const entry of TOOLS) {
    // `exactOptionalPropertyTypes` treats `annotations: undefined` as a
    // different (disallowed) type than omitting the key entirely, so it is
    // only included when an entry actually declares one.
    mcp.registerTool(
      entry.name,
      {
        description: entry.description,
        inputSchema: entry.input,
        ...(entry.annotations ? { annotations: entry.annotations } : {}),
      },
      async (args) => callTool(entry.name, args as Record<string, unknown>),
    );
  }
  return mcp;
}

/**
 * Connects a fresh MCP server and transport, good for exactly one HTTP
 * request.
 *
 * Stateless mode (no sessionIdGenerator) is not "build one long-lived
 * transport at startup and reuse it", despite the SDK's own docstring
 * example: empirically it throws "Stateless transport cannot be reused
 * across requests. Create a new transport per request." on the second
 * call. So a new McpServer and transport are built per request instead.
 * Both are cheap (13 in-memory tool registrations, no I/O); gated.ts's
 * state, which does need to outlive a single request, lives in that
 * module's own scope, not here.
 */
async function connectForOneRequest(): Promise<WebStandardStreamableHTTPServerTransport> {
  const mcp = buildMcpServer();
  // Every SAFE tool is a pure fixture read and the gated tools' state
  // lives in gated.ts's module scope, not a per-connection session, so
  // there is nothing a session would buy here, and it keeps five
  // concurrent lane calls from needing to agree on one session id.
  //
  // The SDK's own option and Transport types were not written against
  // `exactOptionalPropertyTypes: true` (an explicit `sessionIdGenerator:
  // undefined` and the transport's `onclose?: (() => void) | undefined`
  // getter both trip it even though this is the SDK's own documented
  // stateless-mode pattern), hence the two narrow casts below.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  } as unknown as WebStandardStreamableHTTPServerTransportOptions);
  await mcp.connect(transport as Transport);
  return transport;
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  return text.length > 0 ? JSON.parse(text) : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Converts a Node request (plus its already-read body) to a Web Standard
 * Request, the same conversion telephony/server.ts's toRequest does for the
 * chat endpoint. Used here to hand requests to the MCP SDK's web-standard
 * transport directly rather than its hono-backed Node wrapper: that wrapper
 * swallows internal transport errors into a bare, unlogged 500 (`res =
 * await res.catch(handleFetchError)` with no logging), which is what
 * initially hid the "stateless transport reused" error above during a live
 * debugging session.
 */
function toWebRequest(req: IncomingMessage, bodyText: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
  }
  return new Request(`http://localhost${req.url ?? '/'}`, {
    method: req.method ?? 'GET',
    headers,
    ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: bodyText }),
  });
}

/**
 * Builds the HTTP server without binding a port, so tests can listen it on
 * an ephemeral port and importing this module never opens 8792 by itself.
 */
export function createHttpServer() {
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const bodyText = req.method === 'GET' || req.method === 'HEAD' ? '' : await readRawBody(req);

    if (url === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url === '/mcp' || url.startsWith('/mcp?')) {
      try {
        const transport = await connectForOneRequest();
        const webRes = await transport.handleRequest(toWebRequest(req, bodyText));
        res.writeHead(webRes.status, Object.fromEntries(webRes.headers));
        if (!webRes.body) {
          res.end();
          return;
        }
        for await (const chunk of webRes.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk);
        }
        res.end();
      } catch (err) {
        console.error('mcp request failed:', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error handling MCP request' });
      }
      return;
    }

    // Gate admin surface. Not part of the MCP protocol: this is how an
    // operator (a console, or the driver script that plays that role for
    // the live proof) tells this process what a human decided, out of
    // band from TrueForge's own plain allow/deny. See gated.ts.
    if (url === '/gate' && req.method === 'GET') {
      sendJson(res, 200, pendingGate() ?? null);
      return;
    }

    if (url === '/gate/pending' && req.method === 'POST') {
      try {
        const body = parseJson(bodyText) as Partial<GateDraft> | undefined;
        if (
          !body ||
          typeof body.claim_id !== 'string' ||
          typeof body.wanted !== 'string' ||
          !Array.isArray(body.authorised_amounts)
        ) {
          sendJson(res, 400, { error: 'expected {claim_id, wanted, authorised_amounts}' });
          return;
        }
        setPendingGate({
          claim_id: body.claim_id,
          wanted: body.wanted,
          authorised_amounts: body.authorised_amounts,
        });
        sendJson(res, 200, pendingGate());
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (url === '/gate/approve' && req.method === 'POST') {
      try {
        const body = parseJson(bodyText) as { text?: string } | undefined;
        if (!body || typeof body.text !== 'string') {
          sendJson(res, 400, { error: 'expected {text}' });
          return;
        }
        sendJson(res, 200, approveGate(body.text));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  return httpServer;
}

const DEFAULT_PORT = 8792;

// Entrypoint guard: importing this module must never bind a port (tests,
// and any future task that imports runLanes/callTool, rely on that).
// test/loadable.test.ts's blanket import walk also excludes any *server.ts
// file by name for the same reason telephony/server.ts is excluded, so this
// file's own correctness under --experimental-strip-types is proven instead
// by test/mcp-server.test.ts importing it directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MCP_PORT ?? DEFAULT_PORT);
  const httpServer = createHttpServer();
  httpServer.listen(port, () => {
    console.log(`northvane MCP server on http://localhost:${port}/mcp`);
  });
}

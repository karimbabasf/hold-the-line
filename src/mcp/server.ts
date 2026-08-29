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

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  WebStandardStreamableHTTPServerTransport,
  type WebStandardStreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import type { ConsoleEventBody } from '../console/events.ts';
import {
  loadClaim,
  loadComps,
  loadPolicy,
  loadStateRules,
  loadVehicle,
} from '../data/fixtures.ts';
import { daysBetween, settle } from '../settle/settle.ts';
import { LANES, type LaneDef } from './lanes.ts';
import { reportEvent } from './report.ts';
import {
  clipSummary,
  createLaneWindow,
  laneNameFor,
  millis,
  numbersFrom,
  summarise,
  toolSummary,
} from './telemetry.ts';
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
// Reporting to the operator console.
//
// This process runs the tools; a different process (telephony, 8791) holds
// the console's SSE clients, because TrueForge takes MCP servers by remote URL
// only and so the two cannot be one process. Nothing crossed that gap before,
// which is why every pane these tools should fill stayed empty on a live call
// and only ever filled from the recorded fixture.
//
// `report` is a mutable binding rather than a direct call so a test can watch
// what a real tool call puts on screen without an HTTP listener in the way.
// It is never a way to turn reporting off in production: the default is the
// real reporter, and that one is already inert when unconfigured.
// ---------------------------------------------------------------------------

type ConsoleReport = (event: ConsoleEventBody) => void;

let report: ConsoleReport = reportEvent;

/** Redirects reported console events. Returns the previous sink, so a test
 *  can put it back. */
export function setConsoleReport(sink: ConsoleReport): ConsoleReport {
  const previous = report;
  report = sink;
  return previous;
}

const laneWindow = createLaneWindow({ report: (event) => { report(event); } });

/**
 * Tools that are a container for other tool calls rather than a lookup of
 * their own. Reporting `claim.snapshot` as a lane as well as the six lookups
 * it fans out would count its wall time twice in the serial figure and make
 * the parallel-versus-serial counter claim more than actually happened.
 */
const CONTAINER_TOOLS: ReadonlySet<string> = new Set(['claim.snapshot']);

/**
 * The tools TrueForge holds for an operator click, as a set to test against.
 *
 * Derived from gated.ts's `GATED_TOOL_NAMES`, which the check below already
 * ties to this file's own `GATED_TOOLS` and which agent.json's
 * `require_approval_for_tools` is written to match. One constant, so the
 * console's padlock cannot drift from what is actually gated; re-reading
 * agent.json here would put a second copy of that list in the process and
 * make the drift possible again.
 */
const GATED_TOOLS_SET: ReadonlySet<string> = new Set<string>(GATED_TOOL_NAMES);

let toolRunCounter = 0;
/** Provenance for a figure this tool call computed. Prefixed so it can never
 *  be read as one of `settle()`'s own run ids on screen. */
const nextToolRun = (name: string): string =>
  `tool-${name}-${(toolRunCounter++).toString(36)}`;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Reports one tool call opening, on both of the wires the console reads.
 * Returns the function that closes it.
 *
 * `tool` covers every tool on this server, so the panel that draws the MCP
 * surface as a hub and a pipe per tool can light a pipe for anything the
 * agent touches, gated ones included. `lane` covers only the fan-out
 * lookups and keeps exactly the behaviour it had: a container tool still
 * reports no lane of its own, because counting `claim.snapshot` beside the
 * six lookups it fans out would double its wall time in the
 * parallel-versus-serial figure. A fan-out lookup therefore emits both, on
 * purpose.
 *
 * One wrapper rather than a report call per tool, the same rule `lane()`
 * and `runLanes` follow: every path that executes a tool in this file
 * already funnels through here, so a sixteenth tool costs nothing to
 * instrument and cannot be forgotten.
 */
function openTool(name: string, runId: string): (result: unknown, error?: unknown) => void {
  const isLane = !CONTAINER_TOOLS.has(name);
  const laneName = laneNameFor(name);
  // Omitted rather than `gated: false` for the other eleven, matching how
  // every other optional field on these events is reported.
  const gated = GATED_TOOLS_SET.has(name) ? ({ gated: true } as const) : {};
  const startedAt = performance.now();

  if (isLane) {
    laneWindow.began();
    report({ type: 'lane', name: laneName, tool: name, status: 'pending' });
  }
  report({ type: 'tool', tool: name, status: 'pending', ...gated });

  return (result: unknown, error?: unknown) => {
    // Fractional milliseconds, not a rounded integer. A fixture read finishes
    // in well under a millisecond, so rounding reported every lane on a live
    // call as 0 and the console rendered "0.0s" for all five. See millis().
    const elapsed = millis(performance.now() - startedAt);

    if (isLane) {
      laneWindow.ended(elapsed);
      const laneSummary =
        error === undefined ? summarise(name, result) : `failed: ${messageOf(error)}`;
      report({
        type: 'lane',
        name: laneName,
        tool: name,
        status: 'done',
        elapsed_ms: elapsed,
        ...(laneSummary ? { summary: laneSummary } : {}),
      });
    }

    // The tool event says `error` in its own status, so its summary carries
    // the message plainly rather than repeating "failed:" in front of it.
    const summary =
      error === undefined ? toolSummary(name, result) : clipSummary(messageOf(error));
    report({
      type: 'tool',
      tool: name,
      status: error === undefined ? 'done' : 'error',
      elapsed_ms: elapsed,
      ...(summary ? { summary } : {}),
      ...gated,
    });

    if (error !== undefined) return;
    for (const number of numbersFrom(name, result, runId)) report(number);
  };
}

// ---------------------------------------------------------------------------
// The eight SAFE tools (spec section 6). Each reads Task 2's fixture loader;
// none of them mutate anything. Exported individually so they can be unit
// tested without going through HTTP or the MCP wire protocol.
// ---------------------------------------------------------------------------

// A live run found lienholder.payoff_quote ignoring its loan_id and always
// answering for the one lien on file (fixed below it, in this file). Qodo
// then found the same shape of bug on every other single-record lookup
// here: an unknown or mismatched identifier must fail closed rather than
// silently disclosing the one record on file as if it matched.

export function policyLookup(args: { phone: string }) {
  const policy = loadPolicy();
  if (args.phone !== policy.phone) {
    throw new Error(`policy.lookup: no policy on file for phone "${args.phone}".`);
  }
  return policy;
}

/**
 * Matches a claim id the way a person says it out loud.
 *
 * A caller says "claim 40218". The record says "CLM-40218". Demanding the
 * exact stored string means the very first lookup on a real call fails, which
 * is how this was found: by ringing the thing rather than reading it.
 *
 * This is deliberately NOT applied to loan ids. A partial claim id still
 * identifies the same claim, but a loosely matched loan id would identify a
 * DIFFERENT loan and produce a payoff figure the agent then says out loud.
 * Ambiguity is fine for finding a record and unacceptable for money.
 */
export function claimIdMatches(spoken: string, stored: string): boolean {
  const digits = (v: string) => v.replace(/[^0-9]/g, '');
  const a = digits(spoken);
  const b = digits(stored);
  // An empty or too-short input must never match by accident.
  return a.length >= 4 && a === b;
}

export function claimGet(args: { claim_id: string }) {
  const claim = loadClaim();
  if (!claimIdMatches(args.claim_id, claim.claim_id)) {
    throw new Error(`claim.get: no claim on file with id "${args.claim_id}".`);
  }
  return claim;
}

export function vehicleGet(args: { vin: string }) {
  const vehicle = loadVehicle();
  if (args.vin !== vehicle.vin) {
    throw new Error(`vehicle.get: no vehicle on file with VIN "${args.vin}".`);
  }
  return vehicle;
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
  if (args.vin !== vehicle.vin) {
    throw new Error(`claims_history.get: no vehicle on file with VIN "${args.vin}".`);
  }
  return { vin: args.vin, prior_claims: vehicle.prior_damage };
}

export function stateRulesGet(args: { state: string }) {
  const rules = loadStateRules();
  if (args.state !== rules.state) {
    throw new Error(`state_rules.get: no rules on file for state "${args.state}".`);
  }
  return rules;
}

/**
 * Runs the verified settlement engine.
 *
 * This exists because the agent was writing its own arithmetic in the sandbox
 * and arriving at a different number: 7,881.55 against a correct 13,481.12,
 * on a live run. A settlement figure spoken to a claimant cannot come from
 * whatever code a model improvises that turn, and the on-screen breakdown has
 * to add up to what was said. So the maths lives in one tested place and the
 * agent calls it.
 *
 * The sandbox still does real work: the agent runs code to explain a figure a
 * caller challenges, which is a different job from deciding what to pay.
 */
/**
 * One call that gathers the whole claim, fanning out server side.
 *
 * Two problems made this necessary, both found by driving a real call.
 *
 * The records form a dependency chain: the VIN comes from the claim, and the
 * loan id comes from the vehicle. So an agent told to "fetch everything at
 * once" cannot, and instead fires five calls with whatever identifier it has,
 * inventing a `claim_number` parameter that no tool declares. Five validation
 * errors, and the call stalls waiting for tool responses that never come.
 *
 * Doing the fan-out here fixes both. The agent makes one call it cannot get
 * wrong, and the concurrency is real rather than aspirational: the lanes that
 * can run together do, and the timings come back for the console.
 */
export async function claimSnapshot(args: { claim_id: string }) {
  // performance.now, not Date.now: these lookups are local fixture reads that
  // finish inside one millisecond, and a millisecond-resolution clock reports
  // every one of them as 0.
  const started = performance.now();
  const timings: Array<{ lane: string; elapsed_ms: number }> = [];

  /**
   * One inner lookup: timed for the caller's own counter, and reported to
   * the console as its own lane. These are the lanes the operator watches on
   * a real call, since the agent is told to start here rather than call the
   * six lookups one by one.
   */
  async function lane<T>(tool: string, fn: () => T): Promise<T> {
    const runId = nextToolRun(tool);
    const closeTool = openTool(tool, runId);
    const t0 = performance.now();
    try {
      const out = await Promise.resolve(fn());
      timings.push({ lane: tool, elapsed_ms: millis(performance.now() - t0) });
      closeTool(out);
      return out;
    } catch (err) {
      timings.push({ lane: tool, elapsed_ms: millis(performance.now() - t0) });
      closeTool(undefined, err ?? new Error('lookup failed'));
      throw err;
    }
  }

  // First hop: everything reachable from the claim id alone.
  const [claim, rules, storage] = await Promise.all([
    lane('claim.get', () => claimGet(args)),
    lane('state_rules.get', () => stateRulesGet({ state: loadPolicy().state })),
    lane('yard.storage_status', () => yardStorageStatus(args)),
  ]);

  // Second hop: needs the VIN, which only the claim carries.
  const [vehicle, comps] = await Promise.all([
    lane('vehicle.get', () => vehicleGet({ vin: claim.vin })),
    lane('valuation.comps', () => valuationComps({ vin: claim.vin })),
  ]);

  // Third hop: needs the loan id, which only the vehicle carries.
  const payoff = await lane('lienholder.payoff_quote', () =>
    lienholderPayoffQuote({ loan_id: vehicle.lien.loan_id, through_date: vehicle.lien.good_through }),
  );

  const serial_ms = millis(timings.reduce((a, t) => a + t.elapsed_ms, 0));
  return {
    claim, vehicle, comps, payoff, storage, state_rules: rules,
    policy: policyLookup({ phone: loadPolicy().phone }),
    lanes: timings,
    parallel_ms: millis(performance.now() - started),
    serial_ms,
  };
}

export function settlementCalculate(args: { retain_salvage: boolean }) {
  const vehicle = loadVehicle();
  return settle({
    retain_salvage: args.retain_salvage,
    // Always the lender's own validity date. Anything later invents interest.
    through_date: vehicle.lien.good_through,
  });
}

export function yardStorageStatus(args: { claim_id: string }) {
  const claim = loadClaim();
  if (!claimIdMatches(args.claim_id, claim.claim_id)) {
    throw new Error(`yard.storage_status: no claim on file with id "${args.claim_id}".`);
  }
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
    description: 'Fetch a claim by id. Accepts the number as a caller says it, with or without the CLM- prefix.',
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
  {
    name: 'claim.snapshot',
    description:
      'Everything on one claim in a single call: the claim, the vehicle, the valuation ' +
      'comparables, the lienholder payoff, the yard storage and the state rules, gathered ' +
      'concurrently. Start here. Do not call the individual lookups one by one, and do not try ' +
      'to fetch the vehicle or the payoff before you have this, because the VIN and the loan id ' +
      'only exist inside it.',
    input: { claim_id: z.string().describe('the claim number as the caller says it') },
    annotations: { readOnlyHint: true },
    handler: (a) => claimSnapshot(a as { claim_id: string }),
  },
  {
    name: 'settlement.calculate',
    description:
      'Run the settlement calculation. Returns the total loss test, the actual cash value, the ' +
      'lien payoff and the net, with a line-by-line breakdown where every line is tagged as ' +
      'computed or read from a record. Use this rather than working the figures out yourself: ' +
      'the breakdown shown to the adjuster has to add up to the number you say out loud.',
    input: {
      retain_salvage: z
        .boolean()
        .describe('true if the owner keeps the wreck, which deducts the salvage bid'),
    },
    annotations: { readOnlyHint: true },
    handler: (a) => settlementCalculate(a as { retain_salvage: boolean }),
  },
];

/**
 * What the model actually reads back off a tool result.
 *
 * The agent is told to say what `offer.state_settlement` returns word for
 * word, which is the whole point of the gate: an operator files the wording
 * and the agent repeats it rather than paraphrasing a binding sentence. That
 * instruction and a JSON envelope do not mix. Captured on the deployed stack,
 * a caller heard:
 *
 *   {"claim_id":"CLM-40218","wanted":"...","said":"...","authorised_amounts":[...]}
 *
 * read out loud. So a result carrying operator-approved text IS that text, and
 * nothing else reaches the model. The structured fields still exist for the
 * console, which gets them over the event stream rather than through here.
 */
export function spokenResult(result: unknown): string {
  if (
    result !== null &&
    typeof result === 'object' &&
    typeof (result as { said?: unknown }).said === 'string'
  ) {
    return (result as { said: string }).said;
  }
  return JSON.stringify(result);
}

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

  // The lane opens before the deliberate delay, not after it. That delay
  // stands in for the network latency of a real claims database (see
  // lanes.ts), so it is part of what the lane took, and the console's timing
  // has to be the latency an operator would actually be waiting through.
  const runId = nextToolRun(name);
  const closeTool = openTool(name, runId);

  const delay = toolDelay.get(name) ?? 0;
  if (delay > 0) await sleep(delay);

  try {
    const result = await entry.handler(args);
    closeTool(result);
    return { content: [{ type: 'text', text: spokenResult(result) }] };
  } catch (err) {
    closeTool(undefined, err ?? new Error('tool failed'));
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
    parallel_ms: millis(performance.now() - wallStart),
    serial_ms: millis(timed.reduce((sum, t) => sum + t.ms, 0)),
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

/** A tool call or a gate decision is at most a few KB of text. 256KB is
 *  generous and stops an unbounded read from being an easy way to exhaust
 *  process memory on a listener with no auth in front of it. Found by
 *  Qodo: the previous version had no limit at all. */
const MAX_BODY_BYTES = 256 * 1024;

/** Distinguishes an over-limit body from any other failure, so the caller
 *  can answer with 413 rather than a generic 500. */
class BodyTooLargeError extends Error {}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      // Do not req.destroy() here: that kills the socket the response
      // itself needs, so the client sees a connection reset instead of a
      // clean 413. Just stop reading; the caller responds and this
      // connection is closed afterwards (see the catch below), which
      // discards whatever body bytes are still unread rather than letting
      // them corrupt a later request on the same keep-alive connection.
      // Found by Qodo, on the fix for the finding right above this one.
      throw new BodyTooLargeError('request body too large');
    }
    chunks.push(chunk);
  }
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
 * True when `header` (an `Authorization` value) presents `configuredSecret`
 * as a bearer token, or when no secret is configured at all.
 *
 * Pure and dependency-injected (the caller passes the secret in) rather
 * than reading `process.env` directly, so the auth behaviour itself is
 * unit-testable without process-level gymnastics; see
 * createHttpServer's own `gateSecret` option.
 */
export function matchesGateSecret(
  header: string | undefined,
  configuredSecret: string | undefined,
): boolean {
  if (!configuredSecret) return true;
  const presented = header?.replace(/^Bearer /i, '') ?? '';
  const a = Buffer.from(presented);
  const b = Buffer.from(configuredSecret);
  return a.length === b.length && timingSafeEqual(a, b);
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
 *
 * `gateSecret` guards the /gate/* admin routes (see matchesGateSecret);
 * whoever can reach them decides what the agent speaks next, which is
 * exactly the decision this project makes a human make. Defaults to
 * `GATE_ADMIN_SECRET` from the environment rather than always requiring
 * one, because the proof steps in the plan run this process with nothing
 * else set: an unset secret keeps that working and logs why once, rather
 * than silently downgrading security or breaking the documented local demo
 * flow. Binding to loopback (the entrypoint below) closes the network
 * attack surface regardless; this closes the local one, for whenever a
 * console or another local process also reaches this port.
 */
export function createHttpServer(options: { gateSecret?: string } = {}) {
  const gateSecret = options.gateSecret ?? process.env.GATE_ADMIN_SECRET;
  if (!gateSecret) {
    console.warn(
      'GATE_ADMIN_SECRET is not set: the /gate/* admin routes are unauthenticated. ' +
        'Fine for this loopback-only demo process; set it before anything else on the ' +
        'same machine should be untrusted to reach this port.',
    );
  }

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    // A rejected body read (too large, or the socket dropping mid-read) is
    // otherwise an unhandled rejection outside every route's own try/catch,
    // since readRawBody runs before routing. Found by Qodo.
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof BodyTooLargeError) {
        // A client mistake, not a server failure: answered as 413, not
        // logged as an error, and the connection closed afterwards so the
        // unread remainder of an oversized body cannot be misread as the
        // start of the next request on the same keep-alive connection.
        // Found by Qodo, on the previous fix for this same finding.
        res.setHeader('connection', 'close');
        sendJson(res, 413, { error: err.message });
        return;
      }
      console.error('request handling failed:', err);
      sendJson(res, 500, { error: 'internal error' });
    });
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
    // band from TrueForge's own plain allow/deny. See gated.ts. Gated on
    // gateSecret when one is configured (see matchesGateSecret).
    if (url.startsWith('/gate')) {
      if (!matchesGateSecret(req.headers.authorization, gateSecret)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

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
            !Array.isArray(body.authorised_amounts) ||
            // Array.isArray alone let a null or a numeric string through:
            // toCents()'s * coerces null to 0, so [null] silently
            // authorised amount 0. Every element must actually be a
            // finite number. Found by Qodo.
            !body.authorised_amounts.every((a) => typeof a === 'number' && Number.isFinite(a))
          ) {
            sendJson(res, 400, {
              error: 'expected {claim_id, wanted, authorised_amounts: number[]}',
            });
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
  // Loopback only. Qodo flagged the previous default (all interfaces) as
  // letting any host on the network reach the gated tools and the gate
  // admin routes directly, bypassing TrueForge's own approval gate
  // entirely. TrueForge and this process are both local by design (the
  // plan's hard constraint is "remote URL, not stdio", not "public"), so
  // this loses nothing the demo needs.
  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`northvane MCP server on http://localhost:${port}/mcp`);
  });
}

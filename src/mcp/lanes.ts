/**
 * The five fan-out lanes, as data.
 *
 * Spec section 7 warns that lanes returning in 200ms kill the parallel
 * argument on camera: five tool calls that resolve near-instantly look like
 * decoration, not real concurrency. `delayMs` below is a deliberate stand-in
 * for real network latency (a claims database, a valuation feed, a lender's
 * quote API), staggered so the on-screen counter has something honest to
 * show. It is demo latency, not a bug: server.ts sleeps each lane tool for
 * exactly this long before returning.
 *
 * This is a config array on purpose, never five hand-written call sites.
 * `runLanes` (src/mcp/server.ts) loops over it, so a sixth lane costs one
 * more row, not one more call site.
 */

export interface LaneDef {
  readonly name: string;
  readonly tool: string;
  readonly args: unknown;
  /** Deliberate demo latency, not a bug. See the module comment above. */
  readonly delayMs: number;
}

export const LANES: readonly LaneDef[] = [
  {
    name: 'policy and deductible',
    tool: 'policy.lookup',
    args: { phone: '+14155550142' },
    delayMs: 1100,
  },
  {
    name: 'valuation comps',
    tool: 'valuation.comps',
    args: { vin: '4S4BTAFC7M3201884' },
    delayMs: 1600,
  },
  {
    name: 'lienholder payoff',
    tool: 'lienholder.payoff_quote',
    args: { loan_id: 'CAF-9920431', through_date: '2026-10-02' },
    delayMs: 2200,
  },
  {
    name: 'prior damage and history',
    tool: 'claims_history.get',
    args: { vin: '4S4BTAFC7M3201884' },
    delayMs: 2800,
  },
  {
    name: 'state rules',
    tool: 'state_rules.get',
    args: { state: 'AZ' },
    delayMs: 3400,
  },
] as const;

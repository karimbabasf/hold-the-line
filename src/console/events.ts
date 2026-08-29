/**
 * The SSE contract between the call and the operator console.
 *
 * Every event is a flat object with a `type` discriminant and a `t`: the
 * number of milliseconds since the call was answered. `t` is what a replay
 * or a reconnect schedules against, not a wall clock, so the console reads
 * the same whether it is watching a live call or replaying a recording.
 *
 * Wire format, one frame per event:
 *
 *   event: <type>
 *   id: <seq>
 *   data: <JSON-encoded event>
 *
 * `id` is the frame's sequence number, so a client that reconnects can send
 * `Last-Event-ID` and the emitter can replay only what was missed. `data` is
 * the whole event, `type` included, so a client never has to reassemble a
 * payload from the event name alone.
 *
 * Seven event types, deliberately kept to seven rather than one per status
 * transition, so this contract stays small enough for another agent to
 * implement the real emitter against without re-deriving the shape:
 *
 *   - `lane`          one of the five fan-out lookups, pending then done.
 *   - `lanes_summary` the parallel-versus-serial counter once all five land.
 *   - `number`        one number the agent is holding or has said. This is
 *                      the provenance record: `from` is `'computed'` with a
 *                      sandbox `run_id`, or `'record'` with a fixture
 *                      `source` field. Absent `from` means recalled, the
 *                      invariant this whole project rests on, and it has no
 *                      default: an event that forgets to tag itself is a
 *                      caught failure, not a silently-passing one.
 *   - `gate`           the gated-utterance lifecycle: opened with a draft,
 *                      sent back to recompute, or approved (by an operator
 *                      click, or automatically inside a pre-authorised
 *                      amount, in which case `auto` is `true`). `tool`
 *                      carries every event in its own lifecycle: TrueForge's
 *                      own `tool.approval_required` is only an id
 *                      (`tool_calls[].id`, which belongs in this event's
 *                      `id`) pointing at an earlier `call_tool` envelope
 *                      whose `name` is always the string `"call_tool"`, not
 *                      the real tool. The emitter has to resolve
 *                      `arguments.tool_name` (e.g. `"offer.state_settlement"`)
 *                      and `arguments.input.utterance` itself and hand this
 *                      event the resolved values, so a client that only
 *                      observes a later status (say, after reconnecting mid
 *                      gate) never has to chase that correlation itself.
 *   - `hold`           the caller is or is not currently on hold. It is its
 *                      own event rather than folded into `call`, because a
 *                      suspended session stops the hold clock without ending
 *                      the call.
 *   - `session`        the suspend and resume of Task 6, carrying the same
 *                      `run_ids` across the gap as the proof that a resumed
 *                      call recomputed nothing.
 *   - `call`           bookends the stream.
 *   - `transcript`     one line of what was actually said, by the caller or
 *                      by the agent. Added after the seven above, so the
 *                      count is now eight.
 *
 * There is a second wire in this file, `ReportFrame` and `ReportBatch`. The
 * five event types that fill the console's panes are produced where the tools
 * actually run, which is a different process (the MCP server on 8792) from
 * the one holding the SSE clients (telephony, on 8791). A reported frame is
 * the same event body with a wall-clock `at` in place of `t`, because only
 * the telephony process knows when the call was answered.
 *
 * `recordedNorthvaneCall()` below is not a mock: it is a literal transcript
 * of the call script in `docs/superpowers/specs/2026-08-28-northvane-scenario.md`
 * section 3, and every settlement figure in it was read off a real
 * `settle()` run rather than typed by hand (see the reconciliation test in
 * `test/console-events.test.ts`). It exists so the console is demonstrable
 * with no live call: `console.ts` replays it by default, and only switches
 * to a live `EventSource` against `/events` when asked to. The real emitter
 * this contract is written for has to reproduce this same event shape; it
 * does not have to reproduce this exact call.
 */

import type { SettleLine } from '../settle/settle.ts';

/** Milliseconds since the call was answered. */
type Millis = number;

export interface LaneEvent {
  type: 'lane';
  t: Millis;
  /** Human label, e.g. "policy and deductible". */
  name: string;
  /** MCP tool name, e.g. "policy.lookup". */
  tool: string;
  status: 'pending' | 'done';
  /** Present when `status` is `'done'`. */
  elapsed_ms?: number;
  /** Present when `status` is `'done'`. */
  summary?: string;
}

export interface LanesSummaryEvent {
  type: 'lanes_summary';
  t: Millis;
  parallel_ms: number;
  serial_ms: number;
}

export interface NumberEvent {
  type: 'number';
  t: Millis;
  label: string;
  value: number;
  /**
   * Absent means recalled: a figure with no tool behind it. There is no
   * fallback value and no default here on purpose. Render it in red rather
   * than guessing what it should have been tagged.
   */
  from?: 'computed' | 'record' | undefined;
  /** Present when `from` is `'computed'`. */
  run_id?: string;
  /** Present when `from` is `'record'`, e.g. "policy.deductible_collision". */
  source?: string;
  unit?: 'usd' | 'percent' | 'days';
  /**
   * True once this figure has actually been said to the caller, false while
   * the agent is only holding it (for instance, the moment a lane result
   * lands, before it is spoken). The Computed pane renders every `number`
   * event either way, but the "numbers spoken" counter counts only the
   * `spoken: true` ones: a held-but-unspoken value inflating that count
   * would be exactly the kind of overclaim the counter exists to prevent.
   */
  spoken: boolean;
}

export interface GateEvent {
  type: 'gate';
  t: Millis;
  /** Stable id for one gate's lifecycle, opened through its resolution.
   *  Live, this is TrueForge's `tool_calls[].id` for the approval. */
  id: string;
  /**
   * The gated tool this approval is for, e.g. `"offer.state_settlement"`.
   * Present on every status, not only `'opened'`, so a client never has to
   * remember it across a gap.
   *
   * Live, this does NOT come off the approval event. Captured on
   * 2026-08-29, that event carries only `id` and `source_event_id` per tool
   * call: no `name`, no `arguments`. The tool name is `tool_name` inside the
   * `call_tool` envelope on the `model.message` that `source_event_id`
   * points at, and that envelope's `arguments` is a JSON string rather than
   * an object. `resolveGate` in src/trueforge/types.ts does the unwrapping.
   * The envelope's own `name` is always the literal `"call_tool"` and is
   * never what belongs here.
   */
  tool: string;
  status: 'opened' | 'sent_back' | 'approved';
  /** The draft utterance. Present on `'opened'`. Live, this is
   *  `input.utterance` inside the same `call_tool` envelope as `tool`. */
  wanted?: string;
  /** The claim the gate is on. Present on `'opened'` when the draft named
   *  one, so an operator can post the final wording against the right
   *  claim. */
  claim_id?: string;
  /** What was actually spoken. Present on `'approved'`. */
  said?: string;
  /** The settlement breakdown beside the draft. Present on `'opened'`. */
  breakdown?: SettleLine[];
  /** Fixture files the breakdown draws from. Present on `'opened'`. */
  sources?: string[];
  /** Amounts this approval pre-authorises for `settlement.accept`. */
  authorised_amounts?: number[];
  /** True when approved automatically inside a pre-authorised amount rather
   *  than by an operator click. */
  auto?: boolean;
  /** Present on `'sent_back'`, and on an automatic `'approved'` explaining
   *  which pre-authorisation covered it. */
  reason?: string;
}

export interface HoldEvent {
  type: 'hold';
  t: Millis;
  status: 'started' | 'stopped';
}

export interface SessionEvent {
  type: 'session';
  t: Millis;
  status: 'suspended' | 'resumed';
  session_id: string;
  /** Present on `'resumed'`: the same run ids the console showed before the
   *  drop, proving nothing was recomputed. */
  run_ids?: string[];
}

export interface CallEvent {
  type: 'call';
  t: Millis;
  status: 'started' | 'ended';
  claim_id?: string;
  caller?: string;
}

/**
 * One line of what was actually said on the call.
 *
 * `who: 'caller'` is the user message off `POST /v1/chat/completions`, which
 * arrives whole, so it is always `final: true`.
 *
 * `who: 'agent'` is the text on its way out to Telnyx, taken DOWNSTREAM of
 * the speech shaper in `src/telephony/speech.ts`. That matters: the shaper
 * drops a repeated filler and rewrites "$13,481.12" into the words a phone
 * voice reads correctly, and a message the approval gate withheld never
 * reaches it at all. So this is what the caller heard, not what the harness
 * drafted.
 *
 * `text` on an agent partial is CUMULATIVE, not the delta on its own: every
 * `final: false` event carries the whole of what the agent has said this turn
 * so far, and the single `final: true` at the end of the turn carries the
 * settled line. A client renders one line per turn and replaces it on each
 * event rather than appending. Cumulative because a frame lost to a reconnect
 * or to the ring buffer would otherwise take its words out of the transcript
 * silently, and a transcript that quietly drops words is the same class of
 * failure the provenance counters exist to catch.
 */
export interface TranscriptEvent {
  type: 'transcript';
  t: Millis;
  who: 'caller' | 'agent';
  text: string;
  final: boolean;
}

export type ConsoleEvent =
  | LaneEvent
  | LanesSummaryEvent
  | NumberEvent
  | GateEvent
  | HoldEvent
  | SessionEvent
  | CallEvent
  | TranscriptEvent;

/** `Omit` over a union has to be distributed by hand, or it collapses the
 *  seven variants into one object with only their shared keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * One event minus its `t`.
 *
 * A process that is not the telephony process cannot fill `t` in: `t` is
 * milliseconds since THIS call was answered, and only the process holding
 * the call knows when that was. The MCP tool process therefore reports the
 * event body plus a wall-clock `at`, and telephony converts. Nothing else
 * would stay honest across a telephony restart, when the call clock is
 * re-anchored and every queued frame has to be re-stamped against the new
 * origin rather than keeping a `t` measured from an origin that is gone.
 */
export type ConsoleEventBody = DistributiveOmit<ConsoleEvent, 't'>;

/** One reported event and the reporter's wall clock when it happened. */
export interface ReportFrame {
  /** `Date.now()` in the reporting process. Both processes are on one
   *  machine, so this needs no clock-skew correction. */
  at: number;
  event: ConsoleEventBody;
}

/** What `POST /ingest` carries. A batch, not a single frame, so a reporter
 *  that queued events while telephony was restarting delivers them in one
 *  round trip rather than one per event. */
export interface ReportBatch {
  frames: ReportFrame[];
}

/** Runtime guard for an event body, by stamping the `t` it is missing and
 *  reusing the one definition of valid above. */
export function isConsoleEventBody(value: unknown): value is ConsoleEventBody {
  if (typeof value !== 'object' || value === null) return false;
  return isConsoleEvent({ ...(value as Record<string, unknown>), t: 0 });
}

/** Runtime guard for a decoded `POST /ingest` body. */
export function isReportBatch(value: unknown): value is ReportBatch {
  if (typeof value !== 'object' || value === null) return false;
  const frames = (value as Record<string, unknown>)['frames'];
  if (!Array.isArray(frames)) return false;
  return frames.every((f: unknown) => {
    if (typeof f !== 'object' || f === null) return false;
    const frame = f as Record<string, unknown>;
    return typeof frame['at'] === 'number' && isConsoleEventBody(frame['event']);
  });
}

const STATUS_SETS: Record<string, ReadonlySet<string> | undefined> = {
  lane: new Set(['pending', 'done']),
  gate: new Set(['opened', 'sent_back', 'approved']),
  hold: new Set(['started', 'stopped']),
  session: new Set(['suspended', 'resumed']),
  call: new Set(['started', 'ended']),
};

/**
 * Runtime guard for anything decoded off the wire before it is trusted.
 *
 * Checking only `type` and `t` would let a malformed live payload, a gate
 * with `status: "bogus"` or a session missing `session_id`, reach code that
 * assumes the full subtype and either misreads it (an unrecognised gate
 * status is not the same as `'approved'`, but nothing else in the union
 * means "harmless") or throws deep in a render function. Each variant's
 * required fields are checked here instead, once, so nothing downstream has
 * to re-derive what "valid" means for its own branch.
 */
export function isConsoleEvent(value: unknown): value is ConsoleEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const { type } = v;
  if (typeof type !== 'string' || typeof v['t'] !== 'number') return false;

  const statuses = STATUS_SETS[type];
  if (statuses && (typeof v['status'] !== 'string' || !statuses.has(v['status']))) return false;

  switch (type) {
    case 'lane':
      return typeof v['name'] === 'string' && typeof v['tool'] === 'string';
    case 'lanes_summary':
      return typeof v['parallel_ms'] === 'number' && typeof v['serial_ms'] === 'number';
    case 'number':
      return (
        typeof v['label'] === 'string' &&
        typeof v['value'] === 'number' &&
        typeof v['spoken'] === 'boolean' &&
        (v['from'] === undefined || v['from'] === 'computed' || v['from'] === 'record')
      );
    case 'gate':
      return typeof v['id'] === 'string' && typeof v['tool'] === 'string';
    case 'hold':
      return true;
    case 'session':
      return typeof v['session_id'] === 'string';
    case 'call':
      return true;
    case 'transcript':
      return (
        (v['who'] === 'caller' || v['who'] === 'agent') &&
        typeof v['text'] === 'string' &&
        typeof v['final'] === 'boolean'
      );
    default:
      return false;
  }
}

let seqCounter = 0;

/** Encodes one event as a single SSE frame, per the wire format above. */
export function encodeSSE(event: ConsoleEvent, seq?: number): string {
  const id = seq ?? seqCounter++;
  return `event: ${event.type}\nid: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Decodes zero or more complete SSE frames from buffered text.
 *
 * This is a whole-buffer decode, not an incremental stream parser: the
 * console never needs one, because `EventSource` already reassembles frames
 * before handing the browser a `data` string, and a fixture replay is never
 * chunked at all. This function exists for the other half of the contract,
 * a server encoding frames, and for round-trip testing against it.
 */
export function parseSSE(raw: string): ConsoleEvent[] {
  const events: ConsoleEvent[] = [];
  const normalised = raw.replace(/\r\n?/g, '\n');

  for (const block of normalised.split('\n\n')) {
    if (block.trim() === '') continue;

    let data = '';
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5).replace(/^ /, '');
      data += data ? `\n${value}` : value;
    }
    if (!data) continue;

    const parsed: unknown = JSON.parse(data);
    if (isConsoleEvent(parsed)) events.push(parsed);
  }

  return events;
}

const RUN_CASH = 'run-mtdrop7c00';
const RUN_SALVAGE = 'run-mtdrop7c01';
const RUN_RENTAL = 'run-mtdrop7c02';
const SESSION_ID = 'sess-7c21';

/**
 * The Northvane call, recorded.
 *
 * Timing and dialogue follow the call script in the scenario spec, section
 * 3. Every settlement figure and every `SettleLine` in the two gate
 * breakdowns was read off a real `settle()` run for this fixture rather than
 * retyped (see `test/console-events.test.ts`, which asserts this array
 * reconciles to the spec's own tally: 14 numbers spoken, 8 computed, 6
 * traced to a record, 0 recalled; 2 binding utterances, 2 approved, 0 spoken
 * unapproved). If a future edit changes a figure here, that test catches the
 * drift instead of a judge pausing the video to catch it first.
 */
export function recordedNorthvaneCall(): ConsoleEvent[] {
  const cashBreakdown: SettleLine[] = [
    {
      label: 'Market value, three comparables adjusted to 52,400 miles',
      value: 21485.0,
      from: 'computed',
      detail: 'mean of 21543.00, 21702.50, 21209.50 at 0.085/mile',
    },
    {
      label: 'Prior damage',
      value: -640.0,
      from: 'record',
      detail: 'right rear quarter panel repair, 2024',
    },
    {
      label: 'Factory options',
      value: 495.0,
      from: 'computed',
      detail: 'sum of roof rails 150.00 + tow package 220.00 + upgraded audio 125.00',
    },
    {
      label: 'Sales tax at 8.6%',
      value: 1835.24,
      from: 'computed',
      detail: '8.6% of 21340.00',
    },
    {
      label: 'Title and registration',
      value: 70.0,
      from: 'computed',
      detail: 'sum of title 15.00 + registration 55.00',
    },
    {
      label: 'Collision deductible',
      value: -1000.0,
      from: 'record',
      detail: 'policy.deductible_collision',
    },
    {
      label: 'Payoff to Cascade Auto Finance',
      value: -8764.12,
      from: 'computed',
      detail: '8699.72 plus 35 days at 1.84/day, quoted through 2026-10-02',
    },
  ];

  const salvageBreakdown: SettleLine[] = [
    ...cashBreakdown,
    {
      label: 'Salvage retained by owner',
      value: -4301.0,
      from: 'record',
      detail: 'auction bid on 4S4BTAFC7M3201884',
    },
  ];

  const sources = ['policy.json', 'claim.json', 'vehicle.json', 'comps.json', 'state_rules.json'];

  const events: ConsoleEvent[] = [
    { type: 'call', t: 0, status: 'started', claim_id: 'CLM-40218', caller: 'Daniel Ortiz' },
    { type: 'hold', t: 5_000, status: 'started' },

    // FAN-OUT. Five lanes fire at once; the staggered delayMs below is the
    // recorded latency of the actual lanes, not simulated slowness, so the
    // parallel-versus-serial counter is honest rather than decorative.
    { type: 'lane', t: 8_000, name: 'policy and deductible', tool: 'policy.lookup', status: 'pending' },
    { type: 'lane', t: 8_000, name: 'valuation comps', tool: 'valuation.comps', status: 'pending' },
    { type: 'lane', t: 8_000, name: 'lienholder payoff', tool: 'lienholder.payoff_quote', status: 'pending' },
    { type: 'lane', t: 8_000, name: 'prior damage and history', tool: 'claims_history.get', status: 'pending' },
    { type: 'lane', t: 8_000, name: 'state rules', tool: 'state_rules.get', status: 'pending' },

    {
      type: 'lane', t: 9_100, name: 'policy and deductible', tool: 'policy.lookup', status: 'done',
      elapsed_ms: 1_100, summary: 'deductible $1,000.00, rental 4 days left',
    },
    {
      type: 'lane', t: 9_600, name: 'valuation comps', tool: 'valuation.comps', status: 'done',
      elapsed_ms: 1_600, summary: '3 comps, mean $21,485.00 at 52,400 mi',
    },
    {
      type: 'lane', t: 10_200, name: 'lienholder payoff', tool: 'lienholder.payoff_quote', status: 'done',
      elapsed_ms: 2_200, summary: 'payoff $8,764.12 through 2026-10-02',
    },
    {
      type: 'lane', t: 10_800, name: 'prior damage and history', tool: 'claims_history.get', status: 'done',
      elapsed_ms: 2_800, summary: '1 prior claim, -$640.00',
    },
    {
      type: 'lane', t: 11_400, name: 'state rules', tool: 'state_rules.get', status: 'done',
      elapsed_ms: 3_400, summary: 'AZ threshold 75%, tax 8.6%',
    },
    { type: 'lanes_summary', t: 11_450, parallel_ms: 3_400, serial_ms: 11_100 },

    // 0:14, dead air filled with the first two lanes that landed.
    { type: 'number', t: 14_000, label: 'Rental days remaining', value: 4, from: 'computed', run_id: RUN_RENTAL, unit: 'days', spoken: true },
    { type: 'number', t: 14_400, label: 'Yard storage rate', value: 75.0, from: 'record', source: 'claim.storage_per_day', unit: 'usd', spoken: true },

    // 0:20-0:32, SANDBOX CALL 1: settle({ retain_salvage: false }).
    { type: 'number', t: 32_000, label: 'Actual cash value', value: 21_340.0, from: 'computed', run_id: RUN_CASH, unit: 'usd', spoken: true },
    { type: 'number', t: 32_300, label: 'Repair estimate', value: 16_780.0, from: 'record', source: 'claim.repair_estimate', unit: 'usd', spoken: true },
    { type: 'number', t: 32_600, label: 'Loss ratio', value: 78.6, from: 'computed', run_id: RUN_CASH, unit: 'percent', spoken: true },
    { type: 'number', t: 32_900, label: 'Total loss threshold', value: 75, from: 'record', source: 'state_rules.total_loss_threshold_pct', unit: 'percent', spoken: true },

    // 0:38, walking the net figure.
    { type: 'number', t: 38_000, label: 'Sales tax', value: 1_835.24, from: 'computed', run_id: RUN_CASH, unit: 'usd', spoken: true },
    { type: 'number', t: 38_300, label: 'Collision deductible', value: 1_000.0, from: 'record', source: 'policy.deductible_collision', unit: 'usd', spoken: true },
    { type: 'number', t: 38_600, label: 'Net settlement, cash', value: 13_481.12, from: 'computed', run_id: RUN_CASH, unit: 'usd', spoken: true },

    // 0:45, THE PROOF BEAT. The caller's statement shows the principal
    // without the interest since; only the run can produce 8,764.12.
    { type: 'number', t: 45_000, label: 'Lien per diem', value: 1.84, from: 'record', source: 'vehicle.lien.per_diem', unit: 'usd', spoken: true },
    { type: 'number', t: 45_300, label: 'Days of accrued interest', value: 35, from: 'computed', run_id: RUN_CASH, unit: 'days', spoken: true },
    { type: 'number', t: 45_600, label: 'Lienholder payoff', value: 8_764.12, from: 'computed', run_id: RUN_CASH, unit: 'usd', spoken: true },

    // 0:57, THE DROP. The hold clock stops: nobody is on hold on a dead line.
    { type: 'session', t: 57_000, status: 'suspended', session_id: SESSION_ID },
    { type: 'hold', t: 57_000, status: 'stopped' },

    // 1:03, same number rings back. Same run ids: nothing was recomputed.
    { type: 'session', t: 63_000, status: 'resumed', session_id: SESSION_ID, run_ids: [RUN_CASH] },
    { type: 'hold', t: 63_000, status: 'started' },

    // 1:10, THE GATE. First draft, cash only, the word "final" still in it.
    // While this is open, TrueForge answers any further caller utterance
    // with 422: the line is genuinely halted, not merely waiting.
    {
      type: 'gate', t: 70_000, id: 'gate-1', tool: 'offer.state_settlement', status: 'opened',
      wanted: 'Northvane can settle your claim today at 13,481 dollars and 12 cents, final, and that closes claim 40218.',
      breakdown: cashBreakdown,
      sources,
      authorised_amounts: [13_481.12],
    },

    // 1:22, the operator strikes "final" and sends it back for a
    // salvage-retention alternative, because the caller mentioned wanting
    // the car. This is the edit that has to hold the screen.
    {
      type: 'gate', t: 82_000, id: 'gate-1', tool: 'offer.state_settlement', status: 'sent_back',
      reason: "struck 'final': it is an offer, not a take-it-or-leave-it. recompute with salvage retention, the caller wants the car.",
    },

    // 1:30, SANDBOX CALL 2: settle({ retain_salvage: true }).
    { type: 'number', t: 90_000, label: 'Net settlement, salvage retained', value: 9_180.12, from: 'computed', run_id: RUN_SALVAGE, unit: 'usd', spoken: true },

    // 1:38, the amended draft with both options, and the second gate.
    { type: 'number', t: 98_000, label: 'Offer validity', value: 30, from: 'record', source: 'state_rules.offer_validity_days', unit: 'days', spoken: true },
    {
      type: 'gate', t: 98_000, id: 'gate-2', tool: 'offer.state_settlement', status: 'opened',
      wanted:
        'Northvane can settle at 13,481 dollars and 12 cents. That offer stands for 30 days and you may use your own appraiser. ' +
        'If you would rather keep the car, we can settle at 9,180 dollars and 12 cents with a salvage title, subject to your lender releasing it.',
      breakdown: salvageBreakdown,
      sources,
      authorised_amounts: [13_481.12, 9_180.12],
    },
    {
      type: 'gate', t: 101_000, id: 'gate-2', tool: 'offer.state_settlement', status: 'approved',
      said:
        'Northvane can settle at 13,481 dollars and 12 cents. That offer stands for 30 days and you may use your own appraiser. ' +
        'If you would rather keep the car, we can settle at 9,180 dollars and 12 cents with a salvage title, subject to your lender releasing it.',
    },

    // 1:52, the caller takes the cash. 13,481.12 is inside gate-2's
    // authorised amounts, so `settlement.accept` is pre-authorised: no
    // second operator click, and the console says why.
    {
      type: 'gate', t: 112_000, id: 'gate-3', tool: 'settlement.accept', status: 'approved', auto: true,
      said: 'Recorded. Payment goes out today. Storage has run six days, 450 dollars, and I have released the vehicle so it stops tonight.',
      reason: '13,481.12 matches an amount gate-2 already authorised. no operator gate required.',
    },

    // 2:15, end of call. Counters hold on screen.
    { type: 'hold', t: 135_000, status: 'stopped' },
    { type: 'call', t: 135_000, status: 'ended', claim_id: 'CLM-40218' },
  ];

  return events;
}

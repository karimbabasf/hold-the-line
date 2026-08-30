/**
 * One tool result, turned into what the operator sees.
 *
 * Pure functions, no HTTP, so what goes on screen is testable against the
 * real tool handlers and the real fixtures rather than against a hand-written
 * result object that can quietly drift from them.
 *
 * The rule these follow, and the reason this file exists rather than a
 * `JSON.stringify` in the server: a number's provenance has to be the truth.
 * `from: 'record'` means one fixture field was read and this is it, named.
 * `from: 'computed'` means arithmetic ran, and `run_id` says which run. An
 * aggregate of several record fields is computed, not a record lookup: the
 * counters on the console exist to stop this project claiming more than it
 * did, so a default here would be the one bug they cannot catch.
 *
 * A figure produced by `settle()` carries `settle()`'s own run id. Everything
 * else computed carries the id of the tool call that produced it, which is
 * prefixed `tool-` so the two can never be mistaken for each other on screen.
 */

import type { ConsoleEventBody } from '../console/events.ts';
import type { SettleResult } from '../settle/settle.ts';
import { LANES } from './lanes.ts';

export type NumberBody = Extract<ConsoleEventBody, { type: 'number' }>;

/**
 * Milliseconds, kept to the microsecond.
 *
 * Every one of these used to be `Math.round`ed, and every lane on a live call
 * came out 0: the fixtures are local files, so a lookup that a real claims
 * database would answer in 400ms answers here in under a millisecond. The
 * console then rendered "0.0s" for every lane and "0.0s parallel versus 0.0s
 * serial" for the summary, and working software read as broken software.
 *
 * The fix is precision, not padding. Nothing here sleeps to make a number
 * look better; the numbers reported are what actually elapsed, and three
 * decimal places is enough to show it.
 */
export const millis = (ms: number): number => Math.round(ms * 1000) / 1000;

/**
 * A duration as an operator would say it.
 *
 * Under a second reads in milliseconds, because "0.0s" for a 0.4ms lookup is
 * a rounding error presented as a measurement.
 */
export function spokenDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms.toFixed(ms < 10 ? 2 : 0)}ms`;
}

export interface LaneWindowOptions {
  report: (event: ConsoleEventBody) => void;
  /** How long the window waits, with nothing running, before it decides the
   *  fan-out is over. */
  quietMs?: number;
}

/**
 * Measures one fan-out and reports the parallel-versus-serial counter.
 *
 * The counter is measured rather than configured, because a configured one is
 * a claim and this project's whole argument is that its claims are checkable.
 * `parallel_ms` is the wall time from the first lane starting to the last
 * finishing; `serial_ms` is the sum of what each lane actually took.
 *
 * The quiet period is what makes it right across a dependency chain.
 * `claim.snapshot` fans out in three hops, and each hop briefly leaves
 * nothing running. Closing the window there would report the last hop's
 * single lookup as the whole fan-out, which is a smaller and less honest
 * number than the truth.
 */
export function createLaneWindow(options: LaneWindowOptions) {
  const quietMs = options.quietMs ?? 250;
  let running = 0;
  let wallStart = 0;
  let serialMs = 0;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  function cancelClose(): void {
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
  }

  return {
    began(): void {
      cancelClose();
      if (running === 0 && serialMs === 0) wallStart = performance.now();
      running++;
    },
    ended(elapsedMs: number): void {
      serialMs += elapsedMs;
      running = Math.max(0, running - 1);
      if (running > 0) return;
      cancelClose();
      const parallelMs = millis(performance.now() - wallStart);
      const totalSerial = millis(serialMs);
      closeTimer = setTimeout(() => {
        closeTimer = undefined;
        serialMs = 0;
        options.report({ type: 'lanes_summary', parallel_ms: parallelMs, serial_ms: totalSerial });
      }, quietMs);
      closeTimer.unref?.();
    },
  };
}

const usd = (value: number): string =>
  value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const LANE_NAMES: ReadonlyMap<string, string> = new Map(LANES.map((l) => [l.tool, l.name]));

/** Human labels for the tools that are not one of the five fan-out lanes.
 *  A blank lane row on screen is worse than a plain one. */
const OTHER_NAMES: Record<string, string> = {
  'claim.get': 'the claim record',
  'vehicle.get': 'vehicle and lien',
  'yard.storage_status': 'tow yard storage',
  'claim.snapshot': 'whole claim, fanned out',
  'settlement.calculate': 'settlement engine',
  'offer.state_settlement': 'settlement offer, gated',
  'settlement.accept': 'acceptance, gated',
  'payment.issue': 'payment, gated',
  'salvage.release_vehicle': 'salvage release, gated',
  'coverage.deny': 'coverage denial, gated',
};

export function laneNameFor(tool: string): string {
  return LANE_NAMES.get(tool) ?? OTHER_NAMES[tool] ?? tool;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A one-line summary of what a tool came back with, for the lane row. */
export function summarise(tool: string, result: unknown): string | undefined {
  const r = asRecord(result);
  if (!r) return undefined;

  switch (tool) {
    case 'policy.lookup': {
      const deductible = num(r, 'deductible_collision');
      const allowed = num(r, 'rental_days_allowed');
      const used = num(r, 'rental_days_used');
      const rental = allowed !== null && used !== null ? `, rental ${allowed - used} days left` : '';
      return deductible === null ? undefined : `deductible ${usd(deductible)}${rental}`;
    }
    case 'claim.get': {
      const estimate = num(r, 'repair_estimate');
      return `${String(r['claim_id'] ?? 'claim')}, repair estimate ${estimate === null ? 'unknown' : usd(estimate)}`;
    }
    case 'vehicle.get': {
      const mileage = num(r, 'mileage');
      return `${String(r['year'] ?? '')} ${String(r['make'] ?? '')} ${String(r['model'] ?? '')}`.trim() +
        (mileage === null ? '' : `, ${mileage.toLocaleString('en-US')} mi`);
    }
    case 'valuation.comps': {
      const comps = r['comps'];
      return Array.isArray(comps) ? `${comps.length} comparable listings` : undefined;
    }
    case 'lienholder.payoff_quote': {
      const payoff = num(r, 'payoff');
      return payoff === null ? undefined : `payoff ${usd(payoff)} through ${String(r['through_date'] ?? '')}`;
    }
    case 'claims_history.get': {
      const prior = r['prior_claims'];
      if (!Array.isArray(prior)) return undefined;
      const total = prior.reduce((a: number, p: unknown) => a + (num(asRecord(p), 'deduction') ?? 0), 0);
      return `${prior.length} prior claim${prior.length === 1 ? '' : 's'}, ${usd(-total)}`;
    }
    case 'state_rules.get': {
      const threshold = num(r, 'total_loss_threshold_pct');
      const tax = num(r, 'sales_tax_pct');
      return `${String(r['state'] ?? '')} threshold ${threshold}%, tax ${tax}%`;
    }
    case 'yard.storage_status': {
      const days = num(r, 'days_stored');
      const accrued = num(r, 'accrued');
      return days === null || accrued === null ? undefined : `${days} days stored, ${usd(accrued)} accrued`;
    }
    case 'claim.snapshot': {
      const parallel = num(r, 'parallel_ms');
      const serial = num(r, 'serial_ms');
      return parallel === null || serial === null
        ? 'claim, vehicle, comps, payoff, storage, rules'
        : `six lookups in ${spokenDuration(parallel)}, ${spokenDuration(serial)} if serial`;
    }
    case 'settlement.calculate': {
      const net = num(r, 'net');
      const total = r['is_total_loss'] === true ? 'total loss' : 'not a total loss';
      return net === null ? undefined : `${total}, net ${usd(net)}`;
    }
    default:
      return undefined;
  }
}

/** How much of a summary fits on the tool panel at projector size. */
const SUMMARY_MAX_CHARS = 60;

/**
 * One line, whitespace collapsed and cut to fit.
 *
 * The cap is not cosmetic. The tool panel draws one row per tool with the
 * summary beside it, and a row that wraps pushes the rest of the panel off
 * the bottom of a projected screen. A thrown error's message is the case
 * that actually overflows: several of the ones in this server run to two
 * sentences of guidance written for the model to read.
 */
export function clipSummary(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= SUMMARY_MAX_CHARS) return line;
  return `${line.slice(0, SUMMARY_MAX_CHARS - 3).trimEnd()}...`;
}

/**
 * The one line the tool panel shows for a result.
 *
 * `summarise` above writes the lane rows and already covers every lookup, so
 * this reuses it rather than restating those cases, and adds the five gated
 * tools, which have no lane row of their own worth reading. A tool with
 * nothing worth saying gets no summary at all: a JSON dump of the result is
 * worse than a blank, because it is unreadable at that size and it is
 * exactly what the operator is meant to be able to trust this panel not to
 * do.
 */
export function toolSummary(tool: string, result: unknown): string | undefined {
  const shared = summarise(tool, result);
  if (shared !== undefined) return clipSummary(shared);

  const r = asRecord(result);
  if (!r) return undefined;

  switch (tool) {
    case 'offer.state_settlement': {
      const raw = r['authorised_amounts'];
      const amounts = Array.isArray(raw) ? raw.filter((a: unknown) => typeof a === 'number') : [];
      const money = (amounts as number[]).map(usd).join(' or ');
      return clipSummary(`operator wording approved${money ? `, ${money}` : ''}`);
    }
    case 'settlement.accept': {
      const amount = num(r, 'amount');
      const option = typeof r['option'] === 'string' ? r['option'] : '';
      return amount === null ? undefined : clipSummary(`accepted ${usd(amount)}${option ? `, ${option}` : ''}`);
    }
    case 'payment.issue': {
      const amount = num(r, 'amount');
      if (amount === null) return undefined;
      const method = typeof r['method'] === 'string' ? ` by ${r['method']}` : '';
      const reference = typeof r['reference'] === 'string' ? `, ${r['reference']}` : '';
      return clipSummary(`${usd(amount)} issued${method}${reference}`);
    }
    case 'salvage.release_vehicle': {
      const yard = typeof r['yard_id'] === 'string' ? ` to yard ${r['yard_id']}` : '';
      return clipSummary(`vehicle released${yard}, irreversible`);
    }
    case 'coverage.deny': {
      const claim = typeof r['claim_id'] === 'string' ? ` on ${r['claim_id']}` : '';
      const reason = typeof r['reason'] === 'string' ? `, ${r['reason']}` : '';
      return clipSummary(`coverage denied${claim}${reason}`);
    }
    default:
      return undefined;
  }
}

type Unit = NonNullable<NumberBody['unit']>;

function computed(label: string, value: number, runId: string, unit: Unit): NumberBody {
  return { type: 'number', label, value, from: 'computed', run_id: runId, unit, spoken: false };
}

function record(label: string, value: number, source: string, unit: Unit): NumberBody {
  return { type: 'number', label, value, from: 'record', source, unit, spoken: false };
}

/**
 * Every number worth putting on the Computed pane, out of one tool result.
 *
 * `spoken` is false on all of them. A tool returning a figure means the agent
 * is holding it, not that anybody heard it; the telephony process decides
 * what was actually said (see `src/telephony/spoken-numbers.ts`).
 */
export function numbersFrom(tool: string, result: unknown, runId: string): NumberBody[] {
  const r = asRecord(result);
  if (!r) return [];
  const out: NumberBody[] = [];

  switch (tool) {
    case 'policy.lookup': {
      const deductible = num(r, 'deductible_collision');
      if (deductible !== null) {
        out.push(record('Collision deductible', deductible, 'policy.json:deductible_collision', 'usd'));
      }
      const allowed = num(r, 'rental_days_allowed');
      const used = num(r, 'rental_days_used');
      if (allowed !== null && used !== null) {
        // Two fixture fields subtracted is arithmetic, not a lookup.
        out.push(computed('Rental days remaining', allowed - used, runId, 'days'));
      }
      return out;
    }

    case 'claim.get': {
      const estimate = num(r, 'repair_estimate');
      if (estimate !== null) out.push(record('Repair estimate', estimate, 'claim.json:repair_estimate', 'usd'));
      const perDay = num(r, 'storage_per_day');
      if (perDay !== null) out.push(record('Yard storage rate', perDay, 'claim.json:storage_per_day', 'usd'));
      return out;
    }

    case 'state_rules.get': {
      const threshold = num(r, 'total_loss_threshold_pct');
      if (threshold !== null) {
        out.push(record('Total loss threshold', threshold, 'state_rules.json:total_loss_threshold_pct', 'percent'));
      }
      const tax = num(r, 'sales_tax_pct');
      if (tax !== null) out.push(record('Sales tax rate', tax, 'state_rules.json:sales_tax_pct', 'percent'));
      const validity = num(r, 'offer_validity_days');
      if (validity !== null) {
        out.push(record('Offer validity', validity, 'state_rules.json:offer_validity_days', 'days'));
      }
      // The agent says this one out loud when a caller challenges a comp, and
      // speech.ts has a rule for reading it ("0 point 0 8 5 dollars") for that
      // reason. A figure the agent speaks with no source behind it shows red
      // on the console, so it needs one.
      const rate = num(r, 'mileage_adjustment_per_mile');
      if (rate !== null) {
        out.push(record('Mileage adjustment', rate, 'state_rules.json:mileage_adjustment_per_mile', 'usd'));
      }
      return out;
    }

    case 'lienholder.payoff_quote': {
      const perDiem = num(r, 'per_diem');
      if (perDiem !== null) out.push(record('Lien per diem', perDiem, 'vehicle.json:lien.per_diem', 'usd'));
      const days = num(r, 'days');
      if (days !== null) out.push(computed('Days of accrued interest', days, runId, 'days'));
      const payoff = num(r, 'payoff');
      if (payoff !== null) out.push(computed('Lienholder payoff', payoff, runId, 'usd'));
      return out;
    }

    case 'yard.storage_status': {
      const perDay = num(r, 'storage_per_day');
      if (perDay !== null) out.push(record('Yard storage rate', perDay, 'claim.json:storage_per_day', 'usd'));
      const days = num(r, 'days_stored');
      if (days !== null) out.push(computed('Days in the yard', days, runId, 'days'));
      const accrued = num(r, 'accrued');
      if (accrued !== null) out.push(computed('Storage accrued', accrued, runId, 'usd'));
      return out;
    }

    case 'settlement.calculate': {
      const settleRun = typeof r['run_id'] === 'string' ? r['run_id'] : runId;
      const acv = num(r, 'acv');
      if (acv !== null) out.push(computed('Actual cash value', acv, settleRun, 'usd'));
      const ratio = num(r, 'ratio_pct');
      if (ratio !== null) out.push(computed('Loss ratio', ratio, settleRun, 'percent'));
      const payoff = num(r, 'payoff');
      if (payoff !== null) out.push(computed('Lienholder payoff', payoff, settleRun, 'usd'));
      const net = num(r, 'net');
      if (net !== null) {
        const label = (r['lines'] as SettleResult['lines'] | undefined)?.some(
          (l) => l.label === 'Salvage retained by owner',
        )
          ? 'Net settlement, salvage retained'
          : 'Net settlement, cash';
        out.push(computed(label, net, settleRun, 'usd'));
      }
      // The lines read straight off a fixture keep that provenance. Folding
      // them into the computed total would report a lookup as arithmetic.
      const lines = r['lines'];
      if (Array.isArray(lines)) {
        for (const raw of lines as SettleResult['lines']) {
          if (raw?.from !== 'record') continue;
          out.push(record(raw.label, Math.abs(raw.value), raw.detail, 'usd'));
        }
      }
      return out;
    }

    default:
      return out;
  }
}

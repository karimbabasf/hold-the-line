/**
 * The settlement calculation.
 *
 * This is the code the agent runs in the sandbox, and it is the reason the
 * sandbox is not decoration: an insurer committing to a dollar figure over
 * the phone cannot have that figure come out of a language model's head.
 *
 * Two properties matter more than the arithmetic itself.
 *
 * 1. **Every line is attributed.** Each `SettleLine` says whether its value
 *    was computed here or read from a record, and names where. The operator
 *    console renders that, and the on-screen counter is generated from it.
 *    The honest invariant is not "everything is computed", because a
 *    deductible is a lookup. It is that nothing is recalled.
 *
 * 2. **The breakdown sums to the spoken figure.** A judge who pauses the
 *    video and adds up the lines has to land on the number the agent said.
 *    There is a test for exactly that.
 *
 * Money is handled in integer cents throughout. Floats accumulate error and
 * this is the one place in the project where being a cent out is a legal
 * problem rather than a rounding problem.
 */

import {
  loadClaim,
  loadComps,
  loadPolicy,
  loadStateRules,
  loadVehicle,
} from '../data/fixtures.ts';

export interface SettleLine {
  label: string;
  /** Dollars, positive or negative, signed so the lines sum to `net`. */
  value: number;
  from: 'computed' | 'record';
  /** Where the number came from: the arithmetic, or the fixture field. */
  detail: string;
}

export interface SettleResult {
  is_total_loss: boolean;
  acv: number;
  ratio_pct: number;
  payoff: number;
  net: number;
  lines: SettleLine[];
  run_id: string;
}

export interface SettleOptions {
  retain_salvage: boolean;
  /** Date the lien payoff is quoted through, `YYYY-MM-DD`. */
  through_date: string;
}

const toCents = (dollars: number): number => Math.round(dollars * 100);
const toDollars = (cents: number): number => cents / 100;

/**
 * Whole days between two date-only strings.
 *
 * Parsed as UTC on purpose. `new Date('2026-08-28')` is already UTC midnight,
 * but building dates from local parts and subtracting would shift the count
 * by one across a DST boundary, and this number is multiplied by a per-diem
 * and spoken to a customer.
 */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseUtcDate(to) - parseUtcDate(from)) / 86_400_000);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses `YYYY-MM-DD` as UTC midnight, rejecting impossible calendar dates.
 *
 * `Date.parse` is not enough on its own: it normalises rather than rejects,
 * so "2026-02-30" quietly becomes 2 March and silently adds two days of
 * interest to a payoff that gets read aloud to a customer.
 */
function parseUtcDate(value: string): number {
  const match = DATE_ONLY.exec(value);
  if (!match) {
    throw new Error(`expected YYYY-MM-DD, got "${value}"`);
  }
  const [, y, m, d] = match;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`expected YYYY-MM-DD, got "${value}"`);
  }
  // Round-trip check catches the normalised impossible dates.
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== Number(y) ||
    back.getUTCMonth() + 1 !== Number(m) ||
    back.getUTCDate() !== Number(d)
  ) {
    throw new Error(`not a real calendar date: "${value}"`);
  }
  return ms;
}

let runCounter = 0;
const nextRunId = (): string =>
  `run-${Date.now().toString(36)}${(runCounter++).toString(36).padStart(2, '0')}`;

export function settle(options: SettleOptions): SettleResult {
  const claim = loadClaim();
  const vehicle = loadVehicle();
  const comps = loadComps();
  const policy = loadPolicy();
  const rules = loadStateRules();

  const runId = nextRunId();
  const lines: SettleLine[] = [];

  // 1. Adjust each comparable to the subject vehicle's odometer. A comp with
  //    fewer miles than the subject is worth more, so the adjustment is
  //    negative when the comp is lower-mileage.
  const rate = rules.mileage_adjustment_per_mile;
  const adjusted = comps.map((c) => {
    const delta = c.mileage - vehicle.mileage;
    return toCents(c.list_price) + toCents(delta * rate);
  });

  // 2. Mean of the adjusted comps. Any cents remainder is dropped rather than
  //    distributed; on three comps that is at most two cents and it keeps the
  //    displayed mean and the sum consistent.
  const meanCents = Math.round(adjusted.reduce((a, b) => a + b, 0) / adjusted.length);
  lines.push({
    label: 'Market value, three comparables adjusted to 52,400 miles',
    value: toDollars(meanCents),
    from: 'computed',
    detail: `mean of ${adjusted.map((a) => toDollars(a).toFixed(2)).join(', ')} at ${rate}/mile`,
  });

  // 3. Prior damage comes off, factory options go on.
  const priorCents = vehicle.prior_damage.reduce((a, d) => a + toCents(d.deduction), 0);
  const optionsCents = vehicle.options.reduce((a, o) => a + toCents(o.value), 0);
  // A sum of several fixture fields is a computed value, not a record
  // lookup, even though every input is a record. Tagging an aggregate as
  // `record` would let the provenance counter report arithmetic as a direct
  // lookup, which is exactly the claim this project has to be able to defend.
  lines.push({
    label: 'Prior damage',
    value: -toDollars(priorCents),
    from: vehicle.prior_damage.length > 1 ? 'computed' : 'record',
    detail:
      vehicle.prior_damage.length > 1
        ? `sum of ${vehicle.prior_damage.map((d) => d.deduction.toFixed(2)).join(' + ')}`
        : (vehicle.prior_damage[0]?.desc ?? 'none'),
  });
  lines.push({
    label: 'Factory options',
    value: toDollars(optionsCents),
    from: 'computed',
    detail: `sum of ${vehicle.options.map((o) => `${o.name} ${o.value.toFixed(2)}`).join(' + ')}`,
  });

  const acvCents = meanCents - priorCents + optionsCents;

  // 4. Total loss test. Repairs as a percentage of what the car was worth,
  //    against the state threshold.
  const repairCents = toCents(claim.repair_estimate);
  const ratioPct = Math.round((repairCents / acvCents) * 1000) / 10;
  const isTotalLoss = ratioPct >= rules.total_loss_threshold_pct;

  // 5. Tax and fees on the replacement, then the deductible off.
  const taxCents = Math.round((acvCents * rules.sales_tax_pct) / 100);
  const feesCents = toCents(rules.title_fee) + toCents(rules.reg_fee);
  lines.push({
    label: `Sales tax at ${rules.sales_tax_pct}%`,
    value: toDollars(taxCents),
    from: 'computed',
    detail: `${rules.sales_tax_pct}% of ${toDollars(acvCents).toFixed(2)}`,
  });
  lines.push({
    label: 'Title and registration',
    value: toDollars(feesCents),
    from: 'computed',
    detail: `sum of title ${rules.title_fee.toFixed(2)} + registration ${rules.reg_fee.toFixed(2)}`,
  });
  lines.push({
    label: 'Collision deductible',
    value: -policy.deductible_collision,
    from: 'record',
    detail: 'policy.deductible_collision',
  });

  // 6. Lien payoff, accrued to the quote date. This is the number a caller is
  //    most likely to challenge, because their statement shows the principal
  //    without the interest since.
  const days = daysBetween(vehicle.lien.principal_as_of, options.through_date);
  if (days < 0) {
    throw new Error(`through_date ${options.through_date} is before the principal date`);
  }
  // The lender quotes a payoff good through a specific date. Extrapolating
  // past it invents interest the lender has not agreed to, and understates
  // the customer's net on a figure we are about to commit to.
  if (daysBetween(options.through_date, vehicle.lien.good_through) < 0) {
    throw new Error(
      `through_date ${options.through_date} is past the lender quote validity ` +
        `(${vehicle.lien.good_through}); request a fresh payoff quote`,
    );
  }
  const payoffCents = toCents(vehicle.lien.principal) + toCents(vehicle.lien.per_diem * days);
  lines.push({
    label: `Payoff to ${vehicle.lien.lender}`,
    value: -toDollars(payoffCents),
    from: 'computed',
    detail:
      `${vehicle.lien.principal.toFixed(2)} plus ${days} days at ` +
      `${vehicle.lien.per_diem.toFixed(2)}/day, quoted through ${options.through_date}`,
  });

  // 7. Salvage retention: the owner keeps the wreck, so its auction value
  //    comes out of the cheque.
  if (options.retain_salvage) {
    if (!rules.salvage_retention_allowed) {
      throw new Error(`${rules.state} does not allow salvage retention`);
    }
    lines.push({
      label: 'Salvage retained by owner',
      value: -vehicle.salvage_bid,
      from: 'record',
      detail: `auction bid on ${vehicle.vin}`,
    });
  }

  const netCents = lines.reduce((a, l) => a + toCents(l.value), 0);

  return {
    is_total_loss: isTotalLoss,
    acv: toDollars(acvCents),
    ratio_pct: ratioPct,
    payoff: toDollars(payoffCents),
    net: toDollars(netCents),
    lines,
    run_id: runId,
  };
}

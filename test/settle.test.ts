import assert from 'node:assert/strict';
import test from 'node:test';

import { daysBetween, settle } from '../src/settle/settle.ts';

/**
 * Every expected value here comes from the spec's reconciliation table
 * (docs/superpowers/specs/2026-08-28-northvane-scenario.md section 4), which
 * was checked independently before any of this was written.
 *
 * If one of these fails, fix the implementation. Do not move the expectation
 * to match the code: these are the numbers the agent says out loud on a
 * recorded call, and the breakdown on screen has to add up to them.
 */

const THROUGH = '2026-10-02';

test('cash settlement reconciles to 13,481.12', () => {
  const r = settle({ retain_salvage: false, through_date: THROUGH });
  assert.equal(r.acv, 21340.0);
  assert.equal(r.ratio_pct, 78.6);
  assert.equal(r.is_total_loss, true);
  assert.equal(r.payoff, 8764.12);
  assert.equal(r.net, 13481.12);
});

test('salvage retention nets 9,180.12', () => {
  const r = settle({ retain_salvage: true, through_date: THROUGH });
  assert.equal(r.net, 9180.12);
  // The two options differ by exactly the auction bid, nothing else moves.
  const cash = settle({ retain_salvage: false, through_date: THROUGH });
  assert.equal(Math.round((cash.net - r.net) * 100) / 100, 4301.0);
});

test('the breakdown sums to the figure that gets spoken', () => {
  // This is the one a judge can check by pausing the video.
  for (const retain of [false, true]) {
    const r = settle({ retain_salvage: retain, through_date: THROUGH });
    const summed = r.lines.reduce((a, l) => a + l.value, 0);
    assert.equal(Math.round(summed * 100) / 100, r.net, `retain_salvage=${retain}`);
  }
});

test('every line is attributed, none is recalled', () => {
  const r = settle({ retain_salvage: false, through_date: THROUGH });
  assert.ok(r.lines.length >= 6);
  for (const l of r.lines) {
    assert.ok(l.from === 'computed' || l.from === 'record', `${l.label} unattributed`);
    assert.ok(l.detail.length > 0, `${l.label} carries no provenance`);
  }
});

test('the payoff is principal plus 35 days of interest, not the statement figure', () => {
  // The caller challenges this on the call: their statement says 8,699.72.
  // Recall cannot produce 8,764.12, only the run can.
  const r = settle({ retain_salvage: false, through_date: THROUGH });
  assert.equal(daysBetween('2026-08-28', THROUGH), 35);
  assert.equal(Math.round((8699.72 + 1.84 * 35) * 100) / 100, r.payoff);
  const payoffLine = r.lines.find((l) => l.label.startsWith('Payoff'));
  assert.match(payoffLine?.detail ?? '', /35 days/);
});

test('daysBetween counts in UTC so a timezone cannot shift the interest', () => {
  assert.equal(daysBetween('2026-08-28', '2026-08-28'), 0);
  assert.equal(daysBetween('2026-08-28', '2026-08-29'), 1);
  // Across a US DST boundary, which is where a local-time implementation
  // silently gains or loses a day.
  assert.equal(daysBetween('2026-10-31', '2026-11-30'), 30);
  assert.throws(() => daysBetween('not-a-date', THROUGH), /YYYY-MM-DD/);
});

test('a payoff quoted before the principal date is rejected', () => {
  assert.throws(
    () => settle({ retain_salvage: false, through_date: '2026-08-01' }),
    /before the principal date/,
  );
});

test('each run carries its own id so a resumed call can prove nothing was recomputed', () => {
  const a = settle({ retain_salvage: false, through_date: THROUGH });
  const b = settle({ retain_salvage: false, through_date: THROUGH });
  assert.notEqual(a.run_id, b.run_id);
  assert.match(a.run_id, /^run-/);
});

test('the ratio is above the threshold, which is what makes it a total loss', () => {
  const r = settle({ retain_salvage: false, through_date: THROUGH });
  // 16,780 of repairs on a 21,340 car. The state threshold is 75%.
  assert.ok(r.ratio_pct > 75.0);
  assert.equal(r.ratio_pct, 78.6);
});

test('a payoff cannot be quoted past the lender validity window', () => {
  // The lender quotes good through 2026-10-02. Extrapolating past it invents
  // interest the lender never agreed to, on a figure we are about to commit
  // to out loud. Found by Qodo on PR 4.
  assert.throws(
    () => settle({ retain_salvage: false, through_date: '2026-10-03' }),
    /past the lender quote validity/,
  );
  // The boundary itself is still fine.
  assert.equal(settle({ retain_salvage: false, through_date: '2026-10-02' }).payoff, 8764.12);
});

test('impossible calendar dates are rejected, not normalised', () => {
  // Date.parse normalises 2026-02-30 to 2 March, silently adding two days of
  // interest. Found by Qodo on PR 4.
  // 30 February parses fine and normalises to 2 March, so only the
  // round-trip check catches it.
  assert.throws(() => daysBetween('2026-02-30', '2026-03-05'), /not a real calendar date/);
  // Month 13 is not valid ISO at all, so Date.parse rejects it first. Both
  // paths are correct rejections, which is why this asserts on either.
  assert.throws(
    () => daysBetween('2026-13-01', '2026-13-05'),
    /not a real calendar date|expected YYYY-MM-DD/,
  );
  assert.throws(() => daysBetween('2026-8-28', '2026-10-02'), /expected YYYY-MM-DD/);
  // A real leap day still works.
  assert.equal(daysBetween('2028-02-29', '2028-03-01'), 1);
});

test('an aggregate of several record fields is computed, not a record lookup', () => {
  // Tagging a sum as `record` would let the provenance counter report
  // arithmetic as a direct lookup, which breaks the one claim this project
  // has to defend. Found by Qodo on PR 4.
  const r = settle({ retain_salvage: false, through_date: THROUGH });
  const byLabel = (needle: string) => r.lines.find((l) => l.label.includes(needle));

  assert.equal(byLabel('Factory options')?.from, 'computed');
  assert.match(byLabel('Factory options')?.detail ?? '', /sum of/);
  assert.equal(byLabel('Title and registration')?.from, 'computed');
  assert.match(byLabel('Title and registration')?.detail ?? '', /sum of/);

  // A single stored field stays a record lookup.
  assert.equal(byLabel('Collision deductible')?.from, 'record');
});

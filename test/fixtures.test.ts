import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadClaim,
  loadComps,
  loadPolicy,
  loadStateRules,
  loadVehicle,
} from '../src/data/fixtures.ts';

/**
 * These are not "does JSON parse" tests. Every value below feeds the
 * settlement, and a single wrong digit puts the on-screen breakdown out of
 * step with the figure the agent says out loud, which is the one thing a
 * judge can catch by pausing the video.
 */
test('the values the settlement reconciles against', () => {
  assert.equal(loadClaim().repair_estimate, 16780.0);
  assert.equal(loadVehicle().lien.principal, 8699.72);
  assert.equal(loadVehicle().lien.per_diem, 1.84);
  assert.equal(loadVehicle().lien.principal_as_of, '2026-08-28');
  assert.equal(loadVehicle().lien.good_through, '2026-10-02');
  assert.equal(loadVehicle().mileage, 52400);
  assert.equal(loadVehicle().salvage_bid, 4301.0);
  assert.equal(loadPolicy().deductible_collision, 1000.0);
  assert.equal(loadStateRules().total_loss_threshold_pct, 75.0);
  assert.equal(loadStateRules().sales_tax_pct, 8.6);
  assert.equal(loadStateRules().mileage_adjustment_per_mile, 0.085);
  assert.equal(loadStateRules().title_fee + loadStateRules().reg_fee, 70.0);
});

test('three comps, each priced and mileaged', () => {
  const comps = loadComps();
  assert.equal(comps.length, 3);
  assert.deepEqual(
    comps.map((c) => [c.mileage, c.list_price]),
    [
      [41200, 22495.0],
      [58900, 21150.0],
      [55100, 20980.0],
    ],
  );
});

test('the vehicle carries one prior damage deduction and three options', () => {
  const v = loadVehicle();
  assert.equal(v.prior_damage.reduce((a, d) => a + d.deduction, 0), 640.0);
  assert.equal(v.options.reduce((a, o) => a + o.value, 0), 495.0);
});

test('the claim and the policy refer to the same vehicle and holder', () => {
  assert.equal(loadClaim().policy_id, loadPolicy().policy_id);
  assert.equal(loadClaim().vin, loadVehicle().vin);
  assert.equal(loadPolicy().state, loadStateRules().state);
});

test('nothing here is a real record', () => {
  // Rule 7 of the hackathon: only data that is ours to connect. This is a
  // guard against someone swapping in something real later.
  assert.match(loadStateRules().note, /fictional|demo/i);
  assert.match(loadPolicy().phone, /^\+1415555\d{4}$/); // 555 range, unassignable
});

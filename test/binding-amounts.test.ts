import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindingAmountsFrom,
  spokenAmounts,
  unauthorisedAmounts,
} from '../src/telephony/binding-amounts.ts';

/**
 * The backstop under the approval gate. Captured live on 2026-08-29: over
 * eight runs of one caller turn, the agent put the net settlement in the
 * caller's ear four times without an operator ever seeing it, and in half of
 * those it never opened a gate at all. These are the rules that stop that.
 */

const NET = 13481.12;
const SETTLEMENT = JSON.stringify({
  is_total_loss: true,
  acv: 21340,
  payoff: 8764.12,
  net: NET,
  run_id: 'run-mtel71m301',
});

test('binding amounts are read off a settlement response', () => {
  assert.deepEqual(bindingAmountsFrom(SETTLEMENT), [NET]);
});

test('a response that is not a settlement contributes nothing', () => {
  assert.deepEqual(bindingAmountsFrom('not json'), []);
  assert.deepEqual(bindingAmountsFrom(JSON.stringify({ acv: 21340 })), []);
  assert.deepEqual(bindingAmountsFrom(JSON.stringify({ net: 'lots' })), []);
  assert.deepEqual(bindingAmountsFrom(undefined), []);
  assert.deepEqual(bindingAmountsFrom(JSON.stringify(null)), []);
});

test('a figure is read out of speech however the agent formats it', () => {
  // All three shapes were observed live in the same eight runs.
  assert.deepEqual(spokenAmounts('we can pay $13,481.12 today'), [13481.12]);
  assert.deepEqual(spokenAmounts('we can pay 13,481.12 today'), [13481.12]);
  assert.deepEqual(spokenAmounts('we can pay 13481.12 today'), [13481.12]);
});

test('an unauthorised settlement figure is caught in any of those shapes', () => {
  for (const said of [
    'we can pay $13,481.12 today',
    'we can pay 13,481.12 today',
    'we can pay 13481.12 today',
    'the settlement works out to $13,481.12 after the payoff',
  ]) {
    assert.deepEqual(unauthorisedAmounts(said, [NET], []), [NET], said);
  }
});

test('an operator s approval makes exactly that figure speakable', () => {
  assert.deepEqual(unauthorisedAmounts('we can pay $13,481.12', [NET], [NET]), []);
  // And no other figure rides in on it.
  assert.deepEqual(
    unauthorisedAmounts('we can pay $9,000.00', [NET, 9000], [NET]),
    [9000],
  );
});

test('a figure the agent may quote from the record is not held', () => {
  // agent.json calls quoting a record ordinary speech, so a rule that held
  // every number would break the call.
  assert.deepEqual(unauthorisedAmounts('your deductible is $1,000', [NET], []), []);
  assert.deepEqual(
    unauthorisedAmounts('storage runs $75 a day since the 22nd', [NET], []),
    [],
  );
  assert.deepEqual(unauthorisedAmounts('it is a 2021 Subaru Outback', [NET], []), []);
});

test('nothing is held before a settlement has been calculated', () => {
  assert.deepEqual(unauthorisedAmounts('we can pay $13,481.12', [], []), []);
});

test('a figure spelled out in words is held too', () => {
  // Every live capture used digits, but a rule that only reads digits is a
  // rule the agent can walk around by wording. Found by Qodo.
  for (const said of [
    'thirteen thousand four hundred eighty-one dollars and twelve cents',
    'thirteen thousand four hundred and eighty-one dollars and twelve cents',
    'we can settle for thirteen thousand four hundred eighty one dollars twelve cents today',
    // Rounded to whole dollars is the same commitment to anyone listening.
    'we can offer thirteen thousand four hundred eighty-one dollars',
    'we can offer $13,481',
  ]) {
    assert.deepEqual(unauthorisedAmounts(said, [NET], []), [NET], said);
  }
});

test('spelling out an ordinary figure is still not held', () => {
  assert.deepEqual(
    unauthorisedAmounts('your deductible is one thousand dollars', [NET], []),
    [],
  );
  assert.deepEqual(
    unauthorisedAmounts(
      'it is a 2021 Subaru Outback with fifty two thousand four hundred miles',
      [NET],
      [],
    ),
    [],
  );
});

test('an approval covers the figure however the agent words it', () => {
  assert.deepEqual(
    unauthorisedAmounts(
      'thirteen thousand four hundred eighty-one dollars and twelve cents',
      [NET],
      [NET],
    ),
    [],
  );
});

test('amounts compare in cents, never as floats', () => {
  // 8699.72 + 35 * 1.84 is 8764.119999999999 in binary floating point.
  const computed = 8699.72 + 35 * 1.84;
  assert.notEqual(computed, 8764.12);
  assert.deepEqual(unauthorisedAmounts('that is $8,764.12', [computed], []), [
    computed,
  ]);
  assert.deepEqual(unauthorisedAmounts('that is $8,764.12', [computed], [8764.12]), []);
});

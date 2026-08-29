import assert from 'node:assert/strict';
import test from 'node:test';

import { laneNameFor, numbersFrom, summarise } from '../src/mcp/telemetry.ts';
import {
  claimGet,
  lienholderPayoffQuote,
  policyLookup,
  settlementCalculate,
  stateRulesGet,
  yardStorageStatus,
} from '../src/mcp/server.ts';

/**
 * What one tool result becomes on the operator's screen.
 *
 * Every case below runs the real tool against the real fixtures rather than a
 * hand-written result object, so a fixture edit that changes a figure fails
 * here instead of putting a wrong number on the console.
 */

const TOOL_RUN = 'tool-abc';

test('the five fan-out lanes keep their human labels', () => {
  assert.equal(laneNameFor('policy.lookup'), 'policy and deductible');
  assert.equal(laneNameFor('state_rules.get'), 'state rules');
  assert.equal(laneNameFor('lienholder.payoff_quote'), 'lienholder payoff');
});

test('a tool with no lane still gets a label, never a blank row', () => {
  assert.equal(typeof laneNameFor('settlement.calculate'), 'string');
  assert.ok(laneNameFor('settlement.calculate').length > 0);
  assert.equal(laneNameFor('something.unheard.of'), 'something.unheard.of');
});

test('a lane summary says what came back', () => {
  assert.match(summarise('policy.lookup', policyLookup({ phone: '+14155550142' })) ?? '', /1,000\.00/);
  assert.match(summarise('state_rules.get', stateRulesGet({ state: 'AZ' })) ?? '', /75/);
  assert.match(
    summarise('lienholder.payoff_quote', lienholderPayoffQuote({ loan_id: 'CAF-9920431', through_date: '2026-10-02' })) ?? '',
    /8,764\.12/,
  );
});

test('a record lookup is tagged to the fixture field it came out of', () => {
  const numbers = numbersFrom('policy.lookup', policyLookup({ phone: '+14155550142' }), TOOL_RUN);
  const deductible = numbers.find((n) => n.value === 1000);
  assert.ok(deductible, 'the deductible was not reported');
  assert.equal(deductible.from, 'record');
  assert.equal(deductible.source, 'policy.json:deductible_collision');
  assert.equal(deductible.unit, 'usd');
  assert.equal(deductible.spoken, false, 'a figure a tool returned has not been said yet');
});

test('an arithmetic result is tagged computed, with the run that produced it', () => {
  const numbers = numbersFrom(
    'lienholder.payoff_quote',
    lienholderPayoffQuote({ loan_id: 'CAF-9920431', through_date: '2026-10-02' }),
    TOOL_RUN,
  );
  const payoff = numbers.find((n) => n.value === 8764.12);
  assert.ok(payoff, 'the payoff was not reported');
  assert.equal(payoff.from, 'computed');
  assert.equal(payoff.run_id, TOOL_RUN);

  const perDiem = numbers.find((n) => n.value === 1.84);
  assert.equal(perDiem?.from, 'record', 'a per diem read off the lien is not arithmetic');
  assert.equal(perDiem?.source, 'vehicle.json:lien.per_diem');
});

test('a settlement run reports under its own run id, not the tool call id', () => {
  const result = settlementCalculate({ retain_salvage: false });
  const numbers = numbersFrom('settlement.calculate', result, TOOL_RUN);

  const net = numbers.find((n) => n.label.startsWith('Net settlement'));
  assert.ok(net, 'the net settlement was not reported');
  assert.equal(net.value, result.net);
  assert.equal(net.from, 'computed');
  assert.equal(
    net.run_id,
    result.run_id,
    'the settlement engine has its own run id; reporting the tool call id would overclaim',
  );
  assert.notEqual(net.run_id, TOOL_RUN);

  // The record-sourced lines keep their provenance rather than being folded
  // into the computed total.
  const deductible = numbers.find((n) => n.label === 'Collision deductible');
  assert.equal(deductible?.from, 'record');
  assert.equal(deductible?.source, 'policy.deductible_collision');
});

test('every reported number carries a provenance, or is deliberately absent', () => {
  const results: Array<[string, unknown]> = [
    ['policy.lookup', policyLookup({ phone: '+14155550142' })],
    ['claim.get', claimGet({ claim_id: '40218' })],
    ['state_rules.get', stateRulesGet({ state: 'AZ' })],
    ['yard.storage_status', yardStorageStatus({ claim_id: '40218' })],
    ['lienholder.payoff_quote', lienholderPayoffQuote({ loan_id: 'CAF-9920431', through_date: '2026-10-02' })],
    ['settlement.calculate', settlementCalculate({ retain_salvage: true })],
  ];

  for (const [tool, result] of results) {
    const numbers = numbersFrom(tool, result, TOOL_RUN);
    assert.ok(numbers.length > 0, `${tool} reported no numbers at all`);
    for (const n of numbers) {
      assert.ok(Number.isFinite(n.value), `${tool} reported ${n.label} with no value`);
      assert.ok(n.from === 'computed' || n.from === 'record', `${tool} left ${n.label} untagged`);
      if (n.from === 'computed') assert.ok(n.run_id, `${tool} computed ${n.label} with no run id`);
      if (n.from === 'record') assert.ok(n.source, `${tool} read ${n.label} from nowhere named`);
      assert.equal(n.spoken, false);
    }
  }
});

test('a tool that returned an error reports no numbers', () => {
  assert.deepEqual(numbersFrom('policy.lookup', undefined, TOOL_RUN), []);
  assert.deepEqual(numbersFrom('policy.lookup', 'no policy on file', TOOL_RUN), []);
  assert.deepEqual(numbersFrom('unknown.tool', { anything: 1 }, TOOL_RUN), []);
});

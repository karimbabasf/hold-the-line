import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approveGate,
  coverageDeny,
  GATED_TOOL_NAMES,
  isPreAuthorised,
  offerStateSettlement,
  paymentIssue,
  pendingGate,
  salvageReleaseVehicle,
  setPendingGate,
  settlementAccept,
} from '../src/mcp/gated.ts';

test('an amount inside the approved utterance needs no second gate', () => {
  assert.equal(isPreAuthorised(13481.12, [13481.12, 9180.12]), true);
  assert.equal(isPreAuthorised(9180.12, [13481.12, 9180.12]), true);
});

test('any other amount re-fires the gate', () => {
  assert.equal(isPreAuthorised(13481.13, [13481.12, 9180.12]), false);
  assert.equal(isPreAuthorised(0, [13481.12, 9180.12]), false);
  assert.equal(isPreAuthorised(20000, [13481.12, 9180.12]), false);
});

test('comparison is by integer cents, not float equality', () => {
  // 8699.72 + 1.84 * 35 does not necessarily bit-for-bit equal the literal
  // 8764.12 as a float; isPreAuthorised has to survive that, which is the
  // whole reason it compares cents instead of the raw numbers.
  const computed = 8699.72 + 1.84 * 35;
  assert.equal(isPreAuthorised(computed, [8764.12]), true);
});

test('offer.state_settlement returns the operator approved text, not the model argument', () => {
  setPendingGate({
    claim_id: 'CLM-40218',
    wanted: 'Northvane can settle your claim today at 13,481.12, final.',
    authorised_amounts: [13481.12, 9180.12],
  });
  approveGate(
    'Northvane can settle at 13,481.12. That offer stands for 30 days and you may use your own appraiser.',
  );

  const result = offerStateSettlement({
    claim_id: 'CLM-40218',
    utterance: 'Northvane can settle your claim today at 13,481.12, final.',
    authorised_amounts: [13481.12, 9180.12],
  });

  assert.equal(result.wanted, 'Northvane can settle your claim today at 13,481.12, final.');
  assert.equal(
    result.said,
    'Northvane can settle at 13,481.12. That offer stands for 30 days and you may use your own appraiser.',
  );
  assert.notEqual(result.wanted, result.said, 'the edit (striking "final") must be visible in the diff');
});

test('offer.state_settlement refuses to speak before an operator approves', () => {
  setPendingGate({
    claim_id: 'CLM-40218',
    wanted: 'draft never approved',
    authorised_amounts: [],
  });
  // No approveGate call: this must never fall back to the raw argument.
  assert.throws(
    () => offerStateSettlement({ claim_id: 'CLM-40218', utterance: 'x', authorised_amounts: [] }),
    /no approved text on file/,
  );
});

test('approveGate refuses to invent a draft that was never set', () => {
  // Isolate from any pending draft a previous test left behind.
  setPendingGate({ claim_id: 'CLM-1', wanted: 'w', authorised_amounts: [] });
  approveGate('consumed'); // clears the draft
  assert.throws(() => approveGate('too late'), /no pending gate draft/);
});

test('a fresh draft clears a stale decision so it cannot be replayed', () => {
  setPendingGate({ claim_id: 'CLM-A', wanted: 'first draft', authorised_amounts: [1] });
  approveGate('approved first');
  // A second draft starts (the deny-and-redraft path) before anyone
  // consumes the first decision.
  setPendingGate({ claim_id: 'CLM-A', wanted: 'second draft', authorised_amounts: [2] });
  assert.throws(
    () => offerStateSettlement({ claim_id: 'CLM-A', utterance: 'second draft', authorised_amounts: [2] }),
    /no approved text on file/,
  );
});

test('pendingGate reflects the current draft and clears once decided', () => {
  setPendingGate({ claim_id: 'CLM-B', wanted: 'draft b', authorised_amounts: [42] });
  assert.deepEqual(pendingGate(), {
    claim_id: 'CLM-B',
    wanted: 'draft b',
    authorised_amounts: [42],
  });
  approveGate('said b');
  assert.equal(pendingGate(), undefined);
});

test('settlement.accept records a pre-authorised amount', () => {
  setPendingGate({
    claim_id: 'CLM-40218',
    wanted: 'offer',
    authorised_amounts: [13481.12, 9180.12],
  });
  approveGate('offer approved');
  offerStateSettlement({ claim_id: 'CLM-40218', utterance: 'offer', authorised_amounts: [13481.12, 9180.12] });

  const accepted = settlementAccept({ claim_id: 'CLM-40218', amount: 13481.12, option: 'cash' });
  assert.deepEqual(accepted, {
    claim_id: 'CLM-40218',
    amount: 13481.12,
    option: 'cash',
    accepted: true,
  });
});

test('settlement.accept rejects an amount outside the last approved offer', () => {
  setPendingGate({ claim_id: 'CLM-40218', wanted: 'offer', authorised_amounts: [13481.12, 9180.12] });
  approveGate('offer approved');
  offerStateSettlement({ claim_id: 'CLM-40218', utterance: 'offer', authorised_amounts: [13481.12, 9180.12] });

  assert.throws(
    () => settlementAccept({ claim_id: 'CLM-40218', amount: 999.99, option: 'cash' }),
    /not one of the amounts authorised/,
  );
});

test('payment.issue, salvage.release_vehicle and coverage.deny return attributable records', () => {
  const payment = paymentIssue({ claim_id: 'CLM-40218', amount: 13481.12, method: 'ACH' });
  assert.equal(payment.status, 'issued');
  assert.match(payment.reference, /^PMT-/);

  const salvage = salvageReleaseVehicle({ claim_id: 'CLM-40218', yard_id: 'YRD-118' });
  assert.deepEqual(salvage, {
    claim_id: 'CLM-40218',
    yard_id: 'YRD-118',
    released: true,
    irreversible: true,
  });

  const denial = coverageDeny({ claim_id: 'CLM-40218', reason: 'lapsed coverage' });
  assert.deepEqual(denial, { claim_id: 'CLM-40218', reason: 'lapsed coverage', denied: true });
});

test('GATED_TOOL_NAMES matches spec section 6 exactly', () => {
  assert.deepEqual(
    [...GATED_TOOL_NAMES].sort(),
    [
      'coverage.deny',
      'offer.state_settlement',
      'payment.issue',
      'salvage.release_vehicle',
      'settlement.accept',
    ].sort(),
  );
});

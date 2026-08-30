/**
 * What the operator's Reset button has to actually clear.
 *
 * Reset used to clear only the screen. The next call then walked straight
 * back into the previous conversation, because `sessionFor` looks in three
 * places and the reset touched none of them: the bridge's in-memory session
 * per caller, the checkpoint on disk inside the ten minute resume window,
 * and only then a new harness session. Observed live on 2026-08-29: after a
 * reset the store came back with the same `harness_session_id` and a
 * transcript index that had carried on counting from the previous call.
 *
 * The gate is the quieter half of the same bug. `authorisedAmountsByClaim`
 * outlives a single gate on purpose, and the demo claim id never changes,
 * so an amount a human approved on one call would let `settlement.accept`
 * pass on the next with nobody in the loop.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  approveGate,
  clearGateState,
  pendingGate,
  offerStateSettlement,
  setPendingGate,
  settlementAccept,
} from '../src/mcp/gated.ts';
import { checkpoint, forgetAll, resume } from '../src/session/store.ts';

const WINDOW = 10 * 60_000;

function freshStorePath(): string {
  return join(tmpdir(), `htl-reset-${randomUUID()}.json`);
}

test('a checkpoint well inside the resume window does not survive a reset', async () => {
  process.env.SESSION_STORE_PATH = freshStorePath();
  await checkpoint('+14155550142', {
    harness_session_id: '01m181zqvkx59gdwn116qgrbf1',
    transcript_index: 17,
  });
  // Proves the checkpoint was live: without the reset this is what the next
  // call would have resumed into.
  assert.equal((await resume('+14155550142', WINDOW))?.transcript_index, 17);

  await forgetAll();

  assert.equal(await resume('+14155550142', WINDOW), null);
});

test('a reset clears every caller, not just the one on the line', async () => {
  process.env.SESSION_STORE_PATH = freshStorePath();
  await checkpoint('+14155550142', { harness_session_id: 'a', transcript_index: 1 });
  await checkpoint('unknown', { harness_session_id: 'b', transcript_index: 2 });

  await forgetAll();

  assert.equal(await resume('+14155550142', WINDOW), null);
  // `unknown` is the key a call with no caller id lands under, and it is the
  // one that actually bit on the demo line.
  assert.equal(await resume('unknown', WINDOW), null);
});

test('a checkpoint written after a reset is a fresh one, not a revival', async () => {
  process.env.SESSION_STORE_PATH = freshStorePath();
  await checkpoint('unknown', { harness_session_id: 'old', transcript_index: 17 });
  await forgetAll();
  await checkpoint('unknown', { harness_session_id: 'new', transcript_index: 0 });

  const s = await resume('unknown', WINDOW);
  assert.equal(s?.harness_session_id, 'new');
  // The index has to start over. checkpoint() merges onto whatever entry it
  // finds, so a wipe that left the old record behind would show 17 here.
  assert.equal(s?.transcript_index, 0);
});

test('an amount approved before a reset cannot be accepted after one', () => {
  setPendingGate({
    claim_id: 'CLM-40218',
    wanted: 'Your settlement comes to 13,481.12.',
    authorised_amounts: [13_481.12],
  });
  approveGate('Your settlement comes to 13,481.12.');
  offerStateSettlement({
    claim_id: 'CLM-40218',
    utterance: 'Your settlement comes to 13,481.12.',
    authorised_amounts: [13_481.12],
  });
  // Pre-authorised, so it needs no second click. This is the state a reset
  // has to destroy.
  assert.equal(settlementAccept({ claim_id: 'CLM-40218', amount: 13_481.12, option: 'cash' }).accepted, true);

  clearGateState();

  assert.throws(
    () => settlementAccept({ claim_id: 'CLM-40218', amount: 13_481.12, option: 'cash' }),
    /not one of the amounts authorised/,
  );
});

test('a draft left on screen at reset does not wait for the next call', () => {
  setPendingGate({ claim_id: 'CLM-40218', wanted: 'half a sentence', authorised_amounts: [1] });
  assert.equal(pendingGate()?.wanted, 'half a sentence');

  clearGateState();

  assert.equal(pendingGate(), undefined);
});

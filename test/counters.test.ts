import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatNumberLine,
  formatUtteranceLine,
  numbersFromEvents,
  tally,
  tallyUtterances,
  utterancesFromEvents,
} from '../src/console/counters.ts';
import { recordedNorthvaneCall } from '../src/console/events.ts';

test('counts spoken numbers by provenance, never claiming all are computed', () => {
  const t = tally([{ value: 21340.0, from: 'computed' }, { value: 1000.0, from: 'record' }]);
  assert.deepEqual(t, { spoken: 2, computed: 1, record: 1, recalled: 0 });
});

test('a number with no provenance counts as recalled and breaks the invariant', () => {
  const t = tally([{ value: 99, from: undefined }]);
  assert.equal(t.recalled, 1);
});

test('an empty run log is zero everywhere, not an error', () => {
  assert.deepEqual(tally([]), { spoken: 0, computed: 0, record: 0, recalled: 0 });
});

test('a mix of all three provenance states counts each independently', () => {
  const t = tally([
    { value: 1, from: 'computed' },
    { value: 2, from: 'computed' },
    { value: 3, from: 'record' },
    { value: 4, from: undefined },
  ]);
  assert.deepEqual(t, { spoken: 4, computed: 2, record: 1, recalled: 1 });
});

test('binding utterances count only what resolved approved', () => {
  const t = tallyUtterances([
    { approved: true, spoken: true },
    { approved: true, spoken: true },
  ]);
  assert.deepEqual(t, { binding: 2, approved: 2, spokenUnapproved: 0 });
});

test('a spoken-but-unapproved record is caught, not averaged away', () => {
  // The tripwire has to be able to fire. In a correctly wired console this
  // combination should never occur in `utterancesFromEvents`, because a
  // gate that never reached `'approved'` never produces a spoken record at
  // all, but the counter itself has to catch it if it ever did: that is
  // what makes it a safety check rather than decoration.
  const t = tallyUtterances([
    { approved: true, spoken: true },
    { approved: false, spoken: true },
  ]);
  assert.deepEqual(t, { binding: 2, approved: 1, spokenUnapproved: 1 });
});

test('a sent-back draft is absent from the tally, not a near miss', () => {
  // Nothing was said, so it is not "spoken and unapproved" either: it never
  // reached the caller at all.
  assert.deepEqual(tallyUtterances([]), { binding: 0, approved: 0, spokenUnapproved: 0 });
});

test('the recorded Northvane call reconciles to the spec\'s own tally', () => {
  // Spec section 2 / section 3 at 2:10: "numbers spoken 14, computed 8,
  // traced to record 6, recalled 0. binding utterances 2, approved 2,
  // spoken unapproved 0." This asserts the counters against the actual
  // fixture, not a copy of the number, so a future edit to the recording
  // that quietly drops a tag gets caught here.
  const events = recordedNorthvaneCall();

  const numberTally = tally(numbersFromEvents(events));
  assert.deepEqual(numberTally, { spoken: 14, computed: 8, record: 6, recalled: 0 });

  const utteranceTally = tallyUtterances(utterancesFromEvents(events));
  assert.deepEqual(utteranceTally, { binding: 2, approved: 2, spokenUnapproved: 0 });
});

test('renders the two counter lines from spec section 2', () => {
  const numberLine = formatNumberLine({ spoken: 14, computed: 8, record: 6, recalled: 0 });
  assert.equal(numberLine, 'numbers spoken 14  |  computed 8  |  traced to record 6  |  recalled 0');

  const utteranceLine = formatUtteranceLine({ binding: 2, approved: 2, spokenUnapproved: 0 });
  assert.equal(utteranceLine, 'binding utterances 2  |  approved 2  |  spoken unapproved 0');
});

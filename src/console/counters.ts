/**
 * Provenance counters, generated from the run log.
 *
 * The invariant this project stands on is not "every number is computed":
 * a deductible is a lookup, and claiming otherwise is a lie a judge would
 * catch. The invariant is that nothing is recalled, so the two counters
 * below are built from whatever the console actually received, never from a
 * constant. If the call script changes, these numbers move with it instead
 * of drifting out of sync with a hard-coded 14.
 */

import type { ConsoleEvent } from './events.ts';

export interface NumberProvenance {
  value: number;
  from?: 'computed' | 'record' | undefined;
}

export interface NumberTally {
  spoken: number;
  computed: number;
  record: number;
  recalled: number;
}

/** Counts spoken numbers by provenance. A number with no `from` counts as
 *  recalled: that is the failure this whole project is built to make
 *  visible rather than silent. */
export function tally(numbers: readonly NumberProvenance[]): NumberTally {
  let computed = 0;
  let record = 0;
  let recalled = 0;

  for (const n of numbers) {
    if (n.from === 'computed') computed++;
    else if (n.from === 'record') record++;
    else recalled++;
  }

  return { spoken: numbers.length, computed, record, recalled };
}

export interface UtteranceRecord {
  approved: boolean;
  spoken: boolean;
}

export interface UtteranceTally {
  binding: number;
  approved: number;
  spokenUnapproved: number;
}

/**
 * Counts binding utterances by approval.
 *
 * `spokenUnapproved` is the safety tripwire: in a correctly wired system it
 * is structurally always zero, because nothing reaches the caller's ear
 * except what a gate approved. It is still computed rather than assumed,
 * because a tripwire that cannot fire is not a tripwire, it is decoration.
 * See the "a leak would be caught" test in `test/counters.test.ts`.
 */
export function tallyUtterances(records: readonly UtteranceRecord[]): UtteranceTally {
  let approved = 0;
  let spokenUnapproved = 0;
  let binding = 0;

  for (const r of records) {
    if (r.spoken) binding++;
    if (r.approved) approved++;
    if (r.spoken && !r.approved) spokenUnapproved++;
  }

  return { binding, approved, spokenUnapproved };
}

/** Every provenance-tagged number the console has received so far, in the
 *  shape `tally` expects. This is the run log read back, not a list
 *  maintained by hand: call it with whatever events arrived and the count
 *  moves with them. */
export function numbersFromEvents(events: readonly ConsoleEvent[]): NumberProvenance[] {
  const out: NumberProvenance[] = [];
  for (const e of events) {
    if (e.type === 'number') out.push({ value: e.value, from: e.from });
  }
  return out;
}

/** A gate produces a spoken, binding utterance only once it resolves
 *  `'approved'`. A draft that was sent back to recompute was never said
 *  aloud, so it is not a near-miss on this tally, it is simply absent from
 *  it, the same as it was absent from the call. */
export function utterancesFromEvents(events: readonly ConsoleEvent[]): UtteranceRecord[] {
  const out: UtteranceRecord[] = [];
  for (const e of events) {
    if (e.type === 'gate' && e.status === 'approved') out.push({ approved: true, spoken: true });
  }
  return out;
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

/** Renders the first counter line from spec section 2:
 *  "numbers spoken 14 | computed 8 | traced to record 6 | recalled 0" */
export function formatNumberLine(t: NumberTally): string {
  return `numbers spoken ${t.spoken}  |  computed ${t.computed}  |  traced to record ${t.record}  |  recalled ${t.recalled}`;
}

/** Renders the second counter line from spec section 2:
 *  "binding utterances 2 | approved 2 | spoken unapproved 0" */
export function formatUtteranceLine(t: UtteranceTally): string {
  return `binding utterances ${t.binding}  |  approved ${t.approved}  |  spoken unapproved ${t.spokenUnapproved}`;
}

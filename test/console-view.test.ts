/**
 * The two pure pieces of the rebuilt console.
 *
 * Everything else in console.ts needs a DOM, so it is checked by eye against
 * `?until=` snapshots rather than here. These two are not: the caller
 * heading is the title of the whole screen, and the word reveal decides
 * which part of a line animates, which is the difference between a sentence
 * filling in and a paragraph re-flashing every time another clause lands.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { continuesLine, formatCaller, shortSandboxId, splitReveal } from '../src/console/console.ts';

test('the caller heading is a number a room can read', () => {
  assert.equal(formatCaller('+14155550142'), '+1 415 555 0142');
  // What Telnyx sends when it does not identify the caller. It must not be
  // shown as a bare lowercase word next to a claim number.
  assert.equal(formatCaller('unknown'), 'Unknown number');
  assert.equal(formatCaller(undefined), 'Caller');
  assert.equal(formatCaller(''), 'Caller');
  // Anything that is not a plain North American number is shown as it
  // arrived rather than mangled into a shape it does not have.
  assert.equal(formatCaller('+442071838750'), '+442071838750');
  assert.equal(formatCaller('telnyx-conversation-abc'), 'telnyx-conversation-abc');
});

test('only the words that just arrived are revealed', () => {
  // An agent partial carries the whole turn so far, not the delta. The words
  // already on screen have to be recognised, or the whole paragraph animates
  // again every time another clause lands.
  const first = splitReveal('', 'Your car was worth 21,340 dollars.');
  assert.equal(first.head, '');
  assert.equal(first.tail.join(''), 'Your car was worth 21,340 dollars.');

  const second = splitReveal(
    'Your car was worth 21,340 dollars.',
    'Your car was worth 21,340 dollars. Repairs came to 16,780.',
  );
  assert.equal(second.head, 'Your car was worth 21,340 dollars.');
  assert.equal(second.tail.join(''), ' Repairs came to 16,780.');
  assert.equal(second.tail.filter((p) => p.trim() !== '').length, 4);
});

test('a partial that contradicts what is on screen repaints from the divergence', () => {
  // Not a continuation but a correction: the transcript must not keep words
  // the speaker did not say, and must not animate the ones that survived.
  const { head, tail } = splitReveal('I quoted the payoff through October 2', 'I quoted the payoff through November 2');
  assert.equal(head, 'I quoted the payoff through ');
  assert.equal(tail.join(''), 'November 2');
});

test('an unchanged partial reveals nothing', () => {
  const { head, tail } = splitReveal('Bear with me.', 'Bear with me.');
  assert.equal(head, 'Bear with me.');
  assert.deepEqual(tail, []);
});

test('a longer transcription of the same sentence extends it, a new one does not', () => {
  const first = { text: 'Our call just cut off.', t: 4_000 };
  // What Deepgram actually does: sends a line, then the same line with more
  // of it. Two bubbles for one sentence reads as the console losing track.
  assert.equal(
    continuesLine(first, { text: 'Our call just cut off. Can you keep going?', t: 5_200 }),
    true,
  );
  // Half a minute later it is a second thing the caller said, and folding it
  // in would put words in their mouth they did not say together.
  assert.equal(
    continuesLine(first, { text: 'Our call just cut off. Can you keep going?', t: 34_000 }),
    false,
  );
  // Unrelated text is never a continuation, however close it lands.
  assert.equal(continuesLine(first, { text: 'What am I getting?', t: 4_400 }), false);
  // Nor is a shorter line, or the same line again.
  assert.equal(continuesLine(first, { text: 'Our call just cut off.', t: 4_400 }), false);
  assert.equal(continuesLine(first, { text: 'Our call', t: 4_400 }), false);
  assert.equal(continuesLine(undefined, { text: 'anything', t: 0 }), false);
});

test('the container id is shortened to the parts that identify it', () => {
  // What TrueForge actually reports, captured 2026-08-29: Daytona's own
  // handle, 45 characters of mostly punctuation.
  assert.equal(
    shortSandboxId('v1:daytona:default.a05c9b35-16eb-4394-9f59-1401fa3befcb'),
    'daytona · a05c9b35',
  );
  // Anything that is not that shape is shown as it arrived. A harness
  // session id is already readable.
  assert.equal(shortSandboxId('sess-7c21'), 'sess-7c21');
  assert.equal(shortSandboxId('01m17kwn46bj5vgebfzhq0a5wr'), '01m17kwn46bj5vgebfzhq0a5wr');
});

test('a continuation never reaches across the other speaker turn', () => {
  // The transcript keeps ONE settled line, not one per speaker. Per speaker,
  // a caller's "Yes." followed by an agent turn and then a new caller line
  // starting "Yes, ..." rewrote the caller bubble ABOVE the agent's, putting
  // the transcript out of order. Found by Qodo. `continuesLine` is only ever
  // asked about the line at the bottom of the screen now, so the guard is
  // that the caller's own earlier line is no longer a candidate.
  const callerYes = { text: 'Yes.', t: 10_000 };
  const agentTurn = { text: 'Then I will read that back.', t: 12_000 };

  // The agent spoke last, so the agent's line is what a later line is
  // compared against, and a caller line does not continue it.
  assert.equal(continuesLine(agentTurn, { text: 'Yes. And the rental?', t: 14_000 }), false);
  // The caller's own earlier line would still match on text alone, which is
  // exactly why it must not be the line that is offered.
  assert.equal(continuesLine(callerYes, { text: 'Yes. And the rental?', t: 14_000 }), true);
});

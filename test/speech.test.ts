import assert from 'node:assert/strict';
import test from 'node:test';

import { createBridge } from '../src/telephony/harness-bridge.ts';
import {
  createSpeechShaper,
  isFillerLine,
  speakNumbers,
} from '../src/telephony/speech.ts';
import type { TrueForgeClient } from '../src/trueforge/client.ts';
import type { TurnEvent } from '../src/trueforge/types.ts';

/**
 * The three defects captured on a live turn on 2026-08-29, one section each.
 *
 * The message texts below are the real ones off the wire, taken from a turn
 * against the running harness. Reassembled the way the bridge did it before
 * this file existed, they read:
 *
 *   "I can look into that for you. Give me just a second.Checking on that
 *    now.Bear with me.I've got your file here. ..."
 */

/** One live harness message: the opener, then its word deltas. */
function message(text: string): Array<{ type: string; content?: string }> {
  const events: Array<{ type: string; content?: string }> = [{ type: 'model.message' }];
  // The harness splits on token boundaries, including inside numbers, which is
  // why the shaper cannot look at one delta at a time. "$13,481.12" really does
  // arrive as "$13" "," "481" "." "12".
  for (const part of text.split(/(?<=\s)/)) {
    events.push({ type: 'model.message.delta', content: part });
  }
  events.push({ type: 'model.message.delta' });
  return events;
}

/** Drives the shaper the way the bridge does and returns what would be spoken. */
function shape(messages: string[][]): string {
  const shaper = createSpeechShaper();
  let out = '';
  for (const parts of messages) {
    out += shaper.startMessage();
    for (const part of parts) out += shaper.push(part);
  }
  out += shaper.end();
  return out;
}

// ---------------------------------------------------------------------------
// Defect 1: messages from separate rounds were concatenated with no separator.
// ---------------------------------------------------------------------------

test('a new harness message starts a new sentence rather than gluing on to the last', () => {
  const spoken = shape([['Give me just a second.'], ['I have your file here.']]);
  assert.equal(spoken, 'Give me just a second. I have your file here.');
  assert.doesNotMatch(spoken, /\.[A-Z]/, 'a period followed by a capital is the glued signature');
});

test('deltas inside one message are not spaced apart', () => {
  assert.equal(shape([['I', "'ve", ' got', ' it', '.']]), "I've got it.");
});

test('a message that already begins with a space does not get a second one', () => {
  assert.equal(shape([['Ready.'], [' Here it is.']]), 'Ready. Here it is.');
});

test('a glued boundary inside one message is repaired even without the message event', () => {
  assert.equal(shape([['check.Checking on that now.']]), 'check. Checking on that now.');
});

test('the repair still fires when the period and the capital arrive separately', () => {
  // Captured on 8891 on 2026-08-29: the harness sent " down" then "." then
  // "Your", and the period went out on its own, so nothing could see the
  // capital that followed it.
  assert.equal(
    shape([['that breaks down', '.', 'Your settlement comes to']]),
    'that breaks down. Your settlement comes to',
  );
});

test('the repair leaves an abbreviation alone', () => {
  assert.equal(shape([['The U.S. rule applies.']]), 'The U.S. rule applies.');
});

test('an abbreviation split across deltas is still left alone', () => {
  assert.equal(shape([['The U.S', '.', 'Rule applies.']]), 'The U.S.Rule applies.');
});

// ---------------------------------------------------------------------------
// Defect 3: currency and decimals reached TTS unnormalised.
// ---------------------------------------------------------------------------

test('a currency figure is spoken in units, not as a decimal point', () => {
  assert.equal(speakNumbers('The net is $13,481.12.'), 'The net is 13,481 dollars and 12 cents.');
});

test('the digits of a figure are never changed, only the symbols around them', () => {
  const said = speakNumbers('$13,481.12');
  assert.match(said, /\b13,481\b/);
  assert.match(said, /\b12\b/);
  assert.doesNotMatch(said, /\$/);
  assert.doesNotMatch(said, /13,481\.12/);
});

test('whole dollars do not grow a cents clause', () => {
  assert.equal(speakNumbers('$21,340'), '21,340 dollars');
  assert.equal(speakNumbers('$5,000.00'), '5,000 dollars');
});

test('one dollar and one cent are singular', () => {
  assert.equal(speakNumbers('$1.00'), '1 dollar');
  assert.equal(speakNumbers('$1.01'), '1 dollar and 1 cent');
});

test('a leading zero in the cents is not read out', () => {
  assert.equal(speakNumbers('$8,764.05'), '8,764 dollars and 5 cents');
});

test('a rate with more than two decimals is read digit by digit, not as cents', () => {
  // mileage_adjustment_per_mile is 0.085 in fixtures/state_rules.json, so a
  // three-decimal rate is a real figure this can be asked to say. Reading the
  // first two digits as cents would strand the third and speak a different
  // number. Found by Qodo on this PR.
  assert.equal(speakNumbers('$0.085 a mile'), '0 point 0 8 5 dollars a mile');
  assert.equal(speakNumbers('The rate is 0.085 a mile.'), 'The rate is 0 point 0 8 5 a mile.');
  assert.equal(speakNumbers('$1.5'), '1 dollar and 50 cents');
});

test('every digit of a long fraction survives in order', () => {
  const said = speakNumbers('$13,481.1234');
  assert.equal(said.replace(/[^0-9]/g, ''), '134811234');
  assert.doesNotMatch(said, /\$/);
  assert.doesNotMatch(said, /cents/);
});

test('a bare decimal is spoken as point, not as dot', () => {
  assert.equal(speakNumbers('The ratio is 78.6 percent.'), 'The ratio is 78 point 6 percent.');
});

test('a sentence-ending period is not turned into a point', () => {
  assert.equal(
    speakNumbers('The loss was in 2026. The claim is open.'),
    'The loss was in 2026. The claim is open.',
  );
});

test('a figure split across deltas is still normalised', () => {
  const spoken = shape([['We can settle at ', '$13', ',', '481', '.', '12', ' today.']]);
  assert.equal(spoken, 'We can settle at 13,481 dollars and 12 cents today.');
});

test('a figure at the very end of a message is flushed, not swallowed', () => {
  assert.equal(shape([['The net is ', '$13', ',', '481', '.', '12']]), 'The net is 13,481 dollars and 12 cents');
});

test('the approved wording survives word for word around the figure', () => {
  const approved =
    'Northvane will settle this claim as a total loss at $13,481.12, payable once you send the title.';
  const spoken = shape([[approved]]);
  const words = (s: string) => s.replace(/[^a-z ]/gi, ' ').split(/\s+/).filter(Boolean);
  const before = words(approved);
  const after = words(spoken);
  // Only the unit words are added; every word the operator approved is still
  // there, in order.
  assert.deepEqual(
    after.filter((w) => !['dollars', 'and', 'cents'].includes(w) || before.includes(w)),
    before,
  );
});

// ---------------------------------------------------------------------------
// Defect 2: fillers stacked three deep before consecutive tool calls.
// ---------------------------------------------------------------------------

test('the closed set of fillers is recognised however it is punctuated', () => {
  assert.equal(isFillerLine('One moment while I check.'), true);
  assert.equal(isFillerLine('bear with me'), true);
  assert.equal(isFillerLine('Checking on that now!'), true);
  assert.equal(isFillerLine('I have your file here.'), false);
  assert.equal(isFillerLine('Give me just a second, the payoff is $8,764.12.'), false);
});

test('the first filler in a turn is always spoken', () => {
  assert.equal(shape([['Bear with me.'], ['I have your file.']]), 'Bear with me. I have your file.');
});

test('a second filler in the same turn is dropped', () => {
  const spoken = shape([['Bear with me.'], ['Checking on that now.'], ['I have your file.']]);
  assert.equal(spoken, 'Bear with me. I have your file.');
});

test('a filler that trails a content sentence still counts as the one filler', () => {
  const spoken = shape([
    ['I can look into that for you. Give me just a second.'],
    ['Checking on that now.'],
    ['I have your file here.'],
  ]);
  assert.equal(spoken, 'I can look into that for you. Give me just a second. I have your file here.');
});

test('two fillers inside one message are still cut back to one', () => {
  // Captured on 8891 on 2026-08-29: the agent put both fillers in a single
  // harness message, so a rule that only looked at whole messages let the
  // second one through.
  const spoken = shape([['Checking on that now. One moment while I check. I have your file.']]);
  assert.equal(spoken, 'Checking on that now. I have your file.');
});

test('a sentence that only starts like a filler is spoken in full', () => {
  const spoken = shape([['Bear with me.'], ['One moment while I check something else for you.']]);
  assert.equal(spoken, 'Bear with me. One moment while I check something else for you.');
});

test('a message carrying a figure is never dropped as a filler', () => {
  const spoken = shape([
    ['Bear with me.'],
    ['One moment while I check the $8,764.12 payoff.'],
  ]);
  assert.match(spoken, /8,764 dollars and 12 cents/);
});

test('a new turn gets its filler back', () => {
  const shaper = createSpeechShaper();
  let first = shaper.startMessage() + shaper.push('Bear with me.') + shaper.end();
  assert.equal(first, 'Bear with me.');

  const second = createSpeechShaper();
  first = second.startMessage() + second.push('Bear with me.') + second.end();
  assert.equal(first, 'Bear with me.', 'the suppression is per turn, not per process');
});

// ---------------------------------------------------------------------------
// The bridge, driven by the event sequence captured off the live harness.
// ---------------------------------------------------------------------------

/** Replays a fixed list of harness events, ignoring what was sent. */
function replayForge(events: Array<{ type: string; content?: string }>) {
  const client = {
    async createSession() {
      return 'sess-1';
    },
    async *streamTurn(): AsyncGenerator<TurnEvent> {
      for (const e of events) yield e as TurnEvent;
    },
  };
  return client as unknown as TrueForgeClient;
}

async function speak(events: Array<{ type: string; content?: string }>): Promise<string> {
  const bridge = createBridge({
    forge: replayForge(events),
    agentName: 'northvane',
    // The disk store is not what is under test here, and a checkpoint failure
    // is swallowed by design, so this runs against whatever path is set.
  });
  let out = '';
  for await (const delta of bridge.runTurn('claim 40218', '+15550009999')) out += delta.text;
  return out;
}

test('the captured live turn comes out sounding like one person talking', async () => {
  const events = [
    { type: 'turn.created' },
    ...message('I can look into that for you. Give me just a second.'),
    { type: 'mcp.initialize' },
    { type: 'tool.response' },
    ...message('Checking on that now.'),
    { type: 'tool.response' },
    ...message('Bear with me.'),
    { type: 'tool.response' },
    ...message("I've got your file here. I can see the 2021 Outback, and I'm running the settlement now."),
    { type: 'tool.response' },
    ...message('One moment while I check.'),
    { type: 'tool.response' },
    ...message('The net settlement works out to $13,481.12.'),
    { type: 'turn.done' },
  ];

  const spoken = await speak(events);

  assert.equal(
    spoken,
    'I can look into that for you. Give me just a second. ' +
      "I've got your file here. I can see the 2021 Outback, and I'm running the settlement now. " +
      'The net settlement works out to 13,481 dollars and 12 cents.',
  );
  assert.doesNotMatch(spoken, /[a-z]\.[A-Z]/, 'no glued message boundaries');
  assert.doesNotMatch(spoken, /\$/, 'no dollar sign left for TTS to guess at');
});

test('a turn with no text at all yields nothing rather than a stray space', async () => {
  const spoken = await speak([
    { type: 'turn.created' },
    { type: 'model.message' },
    { type: 'model.message.delta' },
    { type: 'turn.done' },
  ]);
  assert.equal(spoken, '');
});

/**
 * Money the model wrote without a dollar sign.
 *
 * Captured on the deployed stack: an approved offer read "the net comes to
 * 13,481.12" and the caller heard "13,481 point 12". The currency rule wanted
 * a dollar sign the model had not written.
 */
test('a bare thousands-and-cents figure is spoken as money, not as "point"', () => {
  assert.equal(
    speakNumbers('It is showing as a total loss, and the net comes to 13,481.12.'),
    'It is showing as a total loss, and the net comes to 13,481 dollars and 12 cents.',
  );
  assert.equal(speakNumbers('1,000.00 deductible'), '1,000 dollars deductible');
});

test('the bare money rule leaves anything that is not an amount alone', () => {
  // A percentage, a per-mile rate and a plain threshold all have to survive it,
  // or the console starts reading rates as settlements.
  assert.equal(speakNumbers('loss ratio is 78.6 percent'), 'loss ratio is 78 point 6 percent');
  assert.equal(speakNumbers('the rate is $0.085 per mile'), 'the rate is 0 point 0 8 5 dollars per mile');
  assert.equal(speakNumbers('threshold is 75'), 'threshold is 75');
});

test('a bare figure keeps its digits exactly, the same as a signed one', () => {
  // The whole point of the shaper: an approved amount may be reworded for a
  // phone voice, never changed.
  const spoken = speakNumbers('the net comes to 13,481.12');
  assert.ok(spoken.includes('13,481'), spoken);
  assert.ok(spoken.includes('12 cents'), spoken);
  assert.ok(!spoken.includes('point'), spoken);
});

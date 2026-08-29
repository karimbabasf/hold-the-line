import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSSE, type ConsoleEvent } from '../src/console/events.ts';
import {
  policyLookup,
  settlementCalculate,
  stateRulesGet,
  yardStorageStatus,
} from '../src/mcp/server.ts';
import { numbersFrom } from '../src/mcp/telemetry.ts';
import type { SettleResult } from '../src/settle/settle.ts';
import { createLiveConsole } from '../src/telephony/live-console.ts';
import { createSpeechShaper } from '../src/telephony/speech.ts';
import { extractSpokenNumbers } from '../src/telephony/spoken-numbers.ts';

/**
 * The seam between the speech shaper and the provenance counters.
 *
 * `speech.ts` rewrites every figure on its way to the caller, because a raw
 * decimal reaches Telnyx TTS as the word "dot". The console then reads the
 * text that actually went out and matches it against what the tools reported,
 * so the shaper's output IS the input to the matcher. Two independent rules
 * for writing a number, one on each side of that seam, drift the moment
 * either changes, and the drift is silent: the "numbers spoken" counter just
 * reads low. A counter that reads low because of a formatting change is worse
 * than no counter, because it looks like evidence.
 *
 * So these tests drive the real shaper rather than a copy of its rules. If
 * `speakNumbers` learns a new form, this is what fails.
 */

interface Sink {
  write(chunk: string): void;
  events(): ConsoleEvent[];
}

function sink(): Sink {
  const chunks: string[] = [];
  return {
    write(chunk) { chunks.push(chunk); },
    events() { return parseSSE(chunks.join('')); },
  };
}

/**
 * Runs raw harness deltas through the real shaper, the way the bridge does.
 *
 * Split the way the harness really splits them, mid-figure, since the shaper
 * holds a trailing number run back until it can see the whole thing and a
 * whole-string call would never exercise that.
 */
function speak(deltas: readonly string[]): string {
  const shaper = createSpeechShaper();
  let out = shaper.startMessage();
  for (const delta of deltas) out += shaper.push(delta);
  out += shaper.end();
  return out;
}

/**
 * Reports the real figures a call produces, with their real provenance, and
 * hands back the settlement run so a caller can assert against the run id
 * that actually produced the number. `settle()` mints a new run id every
 * call, so running it twice is not the same run.
 */
function reportRealNumbers(live: ReturnType<typeof createLiveConsole>): SettleResult {
  const settlement = settlementCalculate({ retain_salvage: false });
  const results: Array<[string, unknown]> = [
    ['policy.lookup', policyLookup({ phone: '+14155550142' })],
    ['state_rules.get', stateRulesGet({ state: 'AZ' })],
    ['yard.storage_status', yardStorageStatus({ claim_id: '40218' })],
    ['settlement.calculate', settlement],
  ];
  for (const [tool, result] of results) {
    for (const number of numbersFrom(tool, result, 'tool-run-1')) live.emit(number);
  }
  return settlement;
}

function spokenNumbers(client: Sink): Array<Record<string, unknown>> {
  return client
    .events()
    .filter((e) => e.type === 'number' && e.spoken)
    .map((e) => e as unknown as Record<string, unknown>);
}

test('the shaper still writes the four forms these counters have to read', () => {
  assert.equal(speak(['$13', ',', '481', '.', '12', ' today.']), '13,481 dollars and 12 cents today.');
  assert.equal(speak(['$1,000.00 off.']), '1,000 dollars off.');
  assert.equal(speak(['$0.085 per mile.']), '0 point 0 8 5 dollars per mile.');
  assert.equal(speak(['78.6 percent.']), '78 point 6 percent.');
});

test('a settlement figure survives the shaper and keeps its run id', () => {
  const live = createLiveConsole();
  const client = sink();
  live.attach(client);
  live.emit({ type: 'call', status: 'started', caller: '+14155550142' });

  const settlement = settlementCalculate({ retain_salvage: false });
  for (const number of numbersFrom('settlement.calculate', settlement, 'tool-run-1')) live.emit(number);

  live.noteSpokenText(speak(['The net settlement is $', '13', ',', '481', '.', '12', '.']));
  live.endSpokenTurn();

  const spoken = spokenNumbers(client);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0]?.['value'], settlement.net);
  assert.equal(spoken[0]?.['from'], 'computed');
  assert.equal(spoken[0]?.['run_id'], settlement.run_id);
});

test('a whole dollar amount survives the shaper losing its cents', () => {
  const live = createLiveConsole();
  const client = sink();
  live.attach(client);
  live.emit({ type: 'call', status: 'started', caller: '+14155550142' });
  reportRealNumbers(live);

  // The shaper drops ".00" entirely: "$1,000.00" goes out as "1,000 dollars".
  live.noteSpokenText(speak(['Your deductible is $1,000.00, and storage runs $75.00 a day.']));
  live.endSpokenTurn();

  const byValue = new Map(spokenNumbers(client).map((n) => [n['value'], n]));
  // policy.lookup and settlement.calculate both report the deductible, and
  // both are true provenance for it, so this asserts the provenance rather
  // than which of the two wrote it last.
  assert.equal(byValue.get(1000)?.['from'], 'record');
  assert.match(String(byValue.get(1000)?.['source']), /deductible_collision/);
  assert.equal(byValue.get(75)?.['unit'], 'usd', 'the 75% threshold was matched instead of the $75.00 rate');
  assert.equal(byValue.get(75)?.['source'], 'claim.json:storage_per_day');
});

test('a rate the shaper reads digit by digit is still one figure', () => {
  assert.deepEqual(extractSpokenNumbers('0 point 0 8 5 dollars per mile'), [
    { value: 0.085, money: true },
  ]);

  const live = createLiveConsole();
  const client = sink();
  live.attach(client);
  live.emit({ type: 'call', status: 'started', caller: '+14155550142' });
  reportRealNumbers(live);

  live.noteSpokenText(speak(['Comps are adjusted at $0.085 per mile.']));
  live.endSpokenTurn();

  const spoken = spokenNumbers(client);
  assert.equal(spoken.length, 1, `read "0 point 0 8 5 dollars" as ${spoken.length} figures`);
  assert.equal(spoken[0]?.['value'], 0.085);
  assert.equal(spoken[0]?.['from'], 'record');
  assert.equal(spoken[0]?.['source'], 'state_rules.json:mileage_adjustment_per_mile');
});

test('a bare decimal the shaper turns into "point" is still one figure', () => {
  assert.deepEqual(extractSpokenNumbers('the loss ratio is 78 point 6 percent'), [
    { value: 78.6, money: false },
  ]);

  const live = createLiveConsole();
  const client = sink();
  live.attach(client);
  live.emit({ type: 'call', status: 'started', caller: '+14155550142' });

  const settlement = settlementCalculate({ retain_salvage: false });
  for (const number of numbersFrom('settlement.calculate', settlement, 'tool-run-1')) live.emit(number);

  live.noteSpokenText(speak([`The loss ratio is ${settlement.ratio_pct} percent.`]));
  live.endSpokenTurn();

  const spoken = spokenNumbers(client);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0]?.['value'], settlement.ratio_pct);
  assert.equal(spoken[0]?.['unit'], 'percent');
  assert.equal(spoken[0]?.['from'], 'computed');
});

test('a whole shaped turn matches every figure it spoke, and invents none', () => {
  const live = createLiveConsole();
  const client = sink();
  live.attach(client);
  live.emit({ type: 'call', status: 'started', caller: '+14155550142' });
  const settlement = reportRealNumbers(live);

  const spokenText = speak([
    'I have run the figures. The actual cash value is $',
    '21', ',', '340', '.', '00',
    ', the loss ratio is 78.6 percent against a 75 percent threshold, ',
    'and your collision deductible is $1,000.00. ',
    'Comps were adjusted at $0.085 per mile. ',
    'Storage has run at $75.00 a day. ',
    'The net settlement is $13,481.12.',
  ]);
  live.noteSpokenText(spokenText);
  live.endSpokenTurn();

  const spoken = spokenNumbers(client);
  const values = spoken.map((n) => n['value']).sort((a, b) => Number(a) - Number(b));
  // Two 75s, and both are real: "$75.00 a day" in dollars and "75 percent"
  // as the threshold. They are separate figures with separate sources.
  assert.deepEqual(values, [0.085, 75, 75, 78.6, 1000, 13481.12, 21340]);
  assert.equal(spoken.find((n) => n['value'] === 13481.12)?.['run_id'], settlement.run_id);

  for (const number of spoken) {
    assert.ok(number['from'], `${String(number['label'])} was spoken with no provenance`);
  }
});

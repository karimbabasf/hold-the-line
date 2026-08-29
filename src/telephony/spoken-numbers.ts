/**
 * Pulls the numbers out of what the agent actually said.
 *
 * The console's provenance counters only mean anything if "spoken" means
 * spoken. The tool process can report what it computed, but it has no idea
 * which of those figures reached the caller's ear, and a counter that
 * assumed every computed figure was said would be exactly the overclaim
 * those counters exist to catch. So the telephony process reads the text on
 * its way to TTS and matches it against what the tools reported.
 *
 * `money` is the flag that keeps this honest in the other direction. A
 * spoken figure with no tool behind it is the failure this project is built
 * to make visible, but "claim 40218" and "filed on 2026-08-21" are not
 * money and flagging them red would bury the one alarm that matters under
 * false ones. Only a figure the agent framed as money (a dollar sign, or
 * the words dollars or cents) is treated as one.
 *
 * Digits only. An agent that says "thirteen thousand dollars" in words is
 * not read here, which is a known gap rather than a silent one: the TTS
 * normalisation in agent.json speaks money as digits plus the word dollars,
 * which is the shape below.
 */

export interface SpokenNumber {
  value: number;
  /** True when the agent framed this as money. */
  money: boolean;
}

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;

/**
 * Alternation order is the whole design here. "13,481 dollars and 12 cents"
 * has to be read as one figure, so that branch comes before the plain
 * dollars branch, which comes before the bare-number branch that would
 * otherwise swallow the 13,481 on its own.
 */
const TOKEN = new RegExp(
  [
    String.raw`\$\s?(${NUM})`,
    String.raw`(${NUM})\s+dollars?\s+and\s+(\d{1,2})\s+cents?`,
    String.raw`(${NUM})\s+dollars?`,
    String.raw`(${NUM})\s+cents?`,
    String.raw`(${NUM})`,
  ].join('|'),
  'gi',
);

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

export function extractSpokenNumbers(text: string): SpokenNumber[] {
  const out: SpokenNumber[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const [, dollarSign, dollarsPart, centsPart, dollarsOnly, centsOnly, bare] = m;
    if (dollarSign !== undefined) {
      out.push({ value: toNumber(dollarSign), money: true });
    } else if (dollarsPart !== undefined && centsPart !== undefined) {
      out.push({ value: toNumber(dollarsPart) + Number(centsPart) / 100, money: true });
    } else if (dollarsOnly !== undefined) {
      out.push({ value: toNumber(dollarsOnly), money: true });
    } else if (centsOnly !== undefined) {
      out.push({ value: Number(centsOnly) / 100, money: true });
    } else if (bare !== undefined) {
      out.push({ value: toNumber(bare), money: false });
    }
  }
  return out;
}

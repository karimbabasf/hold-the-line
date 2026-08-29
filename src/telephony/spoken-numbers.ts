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
/** A fraction the shaper has spelled out, "0 8 5", or left joined, "6". */
const FRACTION = String.raw`\d(?:\s\d)*`;

/**
 * Alternation order is the whole design here, and every branch below exists
 * because `speech.ts` writes a figure that way.
 *
 * "0 point 0 8 5 dollars" comes first, or the plain dollars branch reads the
 * tail of it as five dollars and the rate is lost. "13,481 dollars and 12
 * cents" comes before the plain dollars branch for the same reason. Both come
 * before the bare-number branch, which would otherwise swallow the whole part
 * of either on its own.
 */
const TOKEN = new RegExp(
  [
    String.raw`(${NUM})\s+point\s+(${FRACTION})\s+dollars?`,
    String.raw`(${NUM})\s+dollars?\s+and\s+(\d{1,2})\s+cents?`,
    String.raw`\$\s?(${NUM})`,
    String.raw`(${NUM})\s+dollars?`,
    String.raw`(${NUM})\s+cents?`,
    String.raw`(${NUM})\s+point\s+(${FRACTION})`,
    String.raw`(${NUM})`,
  ].join('|'),
  'gi',
);

/** A date is never a figure this reports, and its parts collide with real
 *  ones: "2026-10-02" offers a 10 that a days ledger entry would match. */
const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

/** Puts a spelled fraction back together: "0 8 5" and "085" are one number. */
function withFraction(whole: string, fraction: string): number {
  return Number(`${whole.replace(/,/g, '')}.${fraction.replace(/\s/g, '')}`);
}

export function extractSpokenNumbers(text: string): SpokenNumber[] {
  const out: SpokenNumber[] = [];
  for (const m of text.replace(ISO_DATE, ' ').matchAll(TOKEN)) {
    const [
      ,
      rateWhole, rateFraction,
      dollarsPart, centsPart,
      dollarSign,
      dollarsOnly,
      centsOnly,
      decimalWhole, decimalFraction,
      bare,
    ] = m;
    if (rateWhole !== undefined && rateFraction !== undefined) {
      out.push({ value: withFraction(rateWhole, rateFraction), money: true });
    } else if (dollarsPart !== undefined && centsPart !== undefined) {
      out.push({ value: toNumber(dollarsPart) + Number(centsPart) / 100, money: true });
    } else if (dollarSign !== undefined) {
      out.push({ value: toNumber(dollarSign), money: true });
    } else if (dollarsOnly !== undefined) {
      out.push({ value: toNumber(dollarsOnly), money: true });
    } else if (centsOnly !== undefined) {
      out.push({ value: Number(centsOnly) / 100, money: true });
    } else if (decimalWhole !== undefined && decimalFraction !== undefined) {
      out.push({ value: withFraction(decimalWhole, decimalFraction), money: false });
    } else if (bare !== undefined) {
      out.push({ value: toNumber(bare), money: false });
    }
  }
  return out;
}

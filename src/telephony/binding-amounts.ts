/**
 * The backstop under the approval gate: which money figures a caller is
 * allowed to hear.
 *
 * The gate catches a binding sentence the agent routes through
 * `offer.state_settlement`. Captured live on 2026-08-29 over eight runs of
 * the same caller turn, the agent did not always route it: in two runs it
 * stated the net settlement as ordinary prose in a message that preceded the
 * gate, and in two more it stated it in a turn that never opened a gate at
 * all. Four of eight runs put an unapproved settlement figure in the
 * caller's ear, and no approval-event-shaped fix can see any of them,
 * because in half of them there is no approval event.
 *
 * So the settlement figure itself is treated as the binding thing. The
 * amount becomes known when `settlement.calculate` returns it, and it stays
 * unspeakable until an operator approves an offer that authorises it.
 *
 * Deliberately narrow. `agent.json` tells the agent that quoting a figure
 * from a record is ordinary speech, so a rule that blocked every number
 * would break the call. Only the net settlement is held, because only the
 * net settlement is what Northvane is being committed to.
 */

/** Integer cents, so two floats that mean the same money compare equal.
 *  Same reason as `isPreAuthorised` in src/mcp/gated.ts. */
const toCents = (dollars: number): number => Math.round(dollars * 100);

/**
 * The amounts in a tool response that commit Northvane to something.
 *
 * `settlement.calculate` returns `net`: the figure the offer is made at.
 * Nothing else in the response binds, so nothing else is collected. A
 * response that is not JSON, or carries no `net`, contributes nothing
 * rather than throwing, because an unrecognised tool result must never take
 * a live call down.
 */
export function bindingAmountsFrom(content: unknown): number[] {
  if (typeof content !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const net = (parsed as { net?: unknown }).net;
  return typeof net === 'number' && Number.isFinite(net) ? [net] : [];
}

/**
 * Every money-shaped number in a piece of speech.
 *
 * Matches `$13,481.12`, `13,481.12` and `13481.12` alike, because the agent
 * has been observed saying all three, and a leading dollar sign is not what
 * makes a figure binding.
 */
const MONEY = /\$?\d+(?:,\d{3})*(?:\.\d{1,2})?/g;

/**
 * The same figures written out in words.
 *
 * Every live capture used digits, but a rule that only reads digits is a
 * rule the agent can walk around by wording, and the invariant is about the
 * amount rather than about one way of typing it. Found by Qodo.
 *
 * False positives cost nothing here: a parsed value is only ever compared
 * against amounts a tool has already declared binding, so "a 2021 Subaru"
 * parsing as 2021 blocks nothing.
 */
const WORD_VALUES = new Map<string, number>([
  ['zero', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4],
  ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9],
  ['ten', 10], ['eleven', 11], ['twelve', 12], ['thirteen', 13],
  ['fourteen', 14], ['fifteen', 15], ['sixteen', 16], ['seventeen', 17],
  ['eighteen', 18], ['nineteen', 19], ['twenty', 20], ['thirty', 30],
  ['forty', 40], ['fifty', 50], ['sixty', 60], ['seventy', 70],
  ['eighty', 80], ['ninety', 90],
]);
const WORD_SCALES = new Map<string, number>([
  ['hundred', 100], ['thousand', 1000], ['million', 1_000_000],
]);

/** Reads runs of number words, pairing a "dollars" run with a "cents" run. */
function spelledAmounts(text: string): number[] {
  const words = text.toLowerCase().replace(/[-,]/g, ' ').split(/[^a-z]+/);
  const found: number[] = [];

  let total = 0;
  let current = 0;
  let started = false;
  let dollars: number | null = null;

  const value = (): number => total + current;
  const reset = (): void => {
    total = 0;
    current = 0;
    started = false;
  };

  for (const word of words) {
    const unit = WORD_VALUES.get(word);
    if (unit !== undefined) {
      current += unit;
      started = true;
      continue;
    }
    const scale = WORD_SCALES.get(word);
    if (scale !== undefined && started) {
      if (scale === 100) current = (current === 0 ? 1 : current) * 100;
      else {
        total += (current === 0 ? 1 : current) * scale;
        current = 0;
      }
      continue;
    }
    // "and" joins parts of one figure ("four hundred and eighty one", and
    // "eighty one dollars and twelve cents"), so it never ends a run.
    if (word === 'and' || word === '') continue;

    if (word === 'dollars' || word === 'dollar') {
      if (started) {
        dollars = value();
        found.push(dollars);
      }
      reset();
      continue;
    }
    if (word === 'cents' || word === 'cent') {
      if (started && dollars !== null) found.push(dollars + value() / 100);
      dollars = null;
      reset();
      continue;
    }
    // Any other word ends the run.
    if (started) found.push(value());
    dollars = null;
    reset();
  }
  if (started) found.push(value());
  return found;
}

export function spokenAmounts(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(MONEY)) {
    const n = Number(match[0].replace(/[$,]/g, ''));
    if (Number.isFinite(n)) found.push(n);
  }
  return [...found, ...spelledAmounts(text)];
}

/**
 * The binding amounts this text would speak that no operator has authorised.
 *
 * Empty means the text is safe to say. Non-empty means it is not, and the
 * caller hears nothing rather than hearing a number nobody approved.
 */
export function unauthorisedAmounts(
  text: string,
  binding: readonly number[],
  authorised: readonly number[],
): number[] {
  if (binding.length === 0) return [];
  const authorisedCents = new Set(authorised.map(toCents));
  const out: number[] = [];

  for (const amount of spokenAmounts(text)) {
    const cents = toCents(amount);
    // Whole dollars count as the same commitment. "thirteen thousand four
    // hundred eighty-one dollars" is the same offer as 13,481.12 to anyone
    // listening, and matching only the exact cents would let the agent
    // round its way past the gate.
    const match = binding.find(
      (b) => toCents(b) === cents || Math.trunc(b) === Math.trunc(amount),
    );
    if (match === undefined) continue;
    if (authorisedCents.has(toCents(match))) continue;
    // Report the binding amount, not the parse, so a log says the same
    // figure the operator would see.
    if (!out.includes(match)) out.push(match);
  }
  return out;
}

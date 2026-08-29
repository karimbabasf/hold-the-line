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

export function spokenAmounts(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(MONEY)) {
    const n = Number(match[0].replace(/[$,]/g, ''));
    if (Number.isFinite(n)) found.push(n);
  }
  return found;
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
  const bindingCents = new Set(binding.map(toCents));
  const authorisedCents = new Set(authorised.map(toCents));
  const out: number[] = [];
  for (const amount of spokenAmounts(text)) {
    const cents = toCents(amount);
    if (bindingCents.has(cents) && !authorisedCents.has(cents)) {
      // Report the binding amount, not the parse, so a caller-facing log
      // says the same figure the operator would see.
      const original = binding.find((b) => toCents(b) === cents);
      if (original !== undefined && !out.includes(original)) out.push(original);
    }
  }
  return out;
}

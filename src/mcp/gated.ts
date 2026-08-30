/**
 * The gated tools and the pending-gate state machine behind them.
 *
 * The core idea this file exists to protect: the gate sits on the
 * utterance, not on the tool call. `offer.state_settlement`'s argument IS
 * the sentence the agent wants to speak, TrueForge holds that call with
 * `require_approval_for_tools` (agent.json), and the tool's return value
 * (never the model's raw argument) is the only thing allowed to reach the
 * caller's ear.
 *
 * TrueForgeClient (src/trueforge/client.ts) already documents the one
 * constraint this design has to work around: the wire has no "allow but
 * change the arguments." An operator who wants different wording denies
 * with a reason and the agent redrafts. So "Approve with edits" cannot
 * happen on the wire, it happens here: an operator's final text is recorded
 * out of band via `approveGate`, *before* the plain allow is sent, and the
 * tool handler below returns that text rather than the argument TrueForge
 * approved. There is still no code path from model text generation to
 * speech for a binding utterance, because nothing is spoken until a human
 * touched this state.
 *
 * A gated tool handler runs only *after* TrueForge's own approval, since
 * TrueForge never forwards a held call to this MCP server until a human (or
 * whatever resolves the approval) allows it. `takeApprovedText` therefore
 * never falls back to the model's argument when no operator text is on
 * file: it throws. Silently trusting the raw argument at that point would
 * quietly reopen the exact bypass this whole file exists to close.
 *
 * Known scope limit, flagged rather than hidden: `draft` and `decision` are
 * one module-global slot, matching a console with one draft box (spec
 * section 1: one adjuster, one call at a time), not a per-claim map. Two
 * claims pending at once would have the second `setPendingGate` overwrite
 * the first. The failure mode is fail-closed, not fail-open: `takeApprovedText`
 * checks `claim_id`, so an overwritten draft surfaces as "no approved text
 * on file", never as one claim's approval being spoken for another. Before
 * any concurrent-claim or multi-session use, this needs a proper
 * claim-or-tool-call-id-keyed store; `authorisedAmountsByClaim` below is
 * already keyed for exactly that reason.
 */

const toCents = (dollars: number): number => Math.round(dollars * 100);

/** The five tools spec section 6 lists as GATED, verbatim. agent.json's
 *  `require_approval_for_tools` must match this list exactly. */
export const GATED_TOOL_NAMES = [
  'offer.state_settlement',
  'settlement.accept',
  'payment.issue',
  'salvage.release_vehicle',
  'coverage.deny',
] as const;

/**
 * True when `amount` (dollars) is one of the amounts the operator's last
 * approved offer authorised. Compared in integer cents, never as floats:
 * a computed amount like a lien payoff is the sum of several rounded
 * cents-denominated lines, and two floats that represent the same money can
 * differ in their last binary digit.
 */
export function isPreAuthorised(amount: number, authorisedAmounts: readonly number[]): boolean {
  const cents = toCents(amount);
  return authorisedAmounts.some((a) => toCents(a) === cents);
}

/** What the model asked to say, awaiting an operator's decision. */
export interface GateDraft {
  claim_id: string;
  wanted: string;
  authorised_amounts: number[];
}

/** A draft plus the operator's final wording. */
export interface GateDecision extends GateDraft {
  said: string;
}

let draft: GateDraft | undefined;
let decision: GateDecision | undefined;
/** Amounts pre-authorised by the most recently completed offer, keyed by
 *  claim id. Persists past `decision` being consumed, so `settlement.accept`
 *  still has something to check against after the offer tool has returned.
 *  Keyed rather than a flat list: a flat list let an amount authorised for
 *  one claim be accepted on any other claim, since only the amount was
 *  checked. Found by Qodo on this PR. */
const authorisedAmountsByClaim = new Map<string, number[]>();

/**
 * Registers a draft the console (or, for the live proof, a driver script
 * standing in for one) has learned about from TrueForge's own
 * `tool.approval_required` event. Starting a new draft clears any stale
 * decision from a previous round, so an old approval can never be replayed
 * against a new draft it was never shown next to.
 */
export function setPendingGate(next: GateDraft): void {
  draft = next;
  decision = undefined;
}

/** The draft currently awaiting an operator's decision, if any. */
export function pendingGate(): GateDraft | undefined {
  return draft;
}

/**
 * Drops the pending draft, the operator's decision, and every amount a
 * previous offer pre-authorised. Called on the operator's reset.
 *
 * `authorisedAmountsByClaim` outlives a single gate on purpose, so
 * `settlement.accept` still has something to check after the offer tool has
 * returned. Across a reset that is exactly wrong: the claim id is the same
 * on every call, so an amount approved on one call would let
 * `settlement.accept` pass on the next one with no human in the loop at all.
 */
export function clearGateState(): void {
  draft = undefined;
  decision = undefined;
  authorisedAmountsByClaim.clear();
}

/**
 * Records the operator's final decision on the current draft. This is the
 * only place a binding utterance's text is allowed to diverge from the
 * model's argument; see the module comment for why that is legitimate.
 */
export function approveGate(finalText: string): GateDecision {
  if (!draft) {
    throw new Error('approveGate: no pending gate draft. Call setPendingGate first.');
  }
  decision = { ...draft, said: finalText };
  draft = undefined;
  return decision;
}

/**
 * Consumed exactly once by the `offer.state_settlement` handler. Throws
 * rather than falling back to the model's own argument when nothing has
 * been approved, which is the invariant this whole file exists to hold.
 *
 * Returns the approved `authorisedAmounts` from the decision itself, not
 * from whatever the live tool call's own argument says: the call is not
 * trusted to accurately restate what an operator actually approved. Found
 * by Qodo on this PR.
 */
function takeApprovedText(claimId: string): { said: string; authorisedAmounts: number[] } {
  if (!decision || decision.claim_id !== claimId) {
    throw new Error(
      `offer.state_settlement: no approved text on file for claim ${claimId}. ` +
        'An operator must call approveGate with the final wording before this tool can return.',
    );
  }
  const { said, authorised_amounts } = decision;
  authorisedAmountsByClaim.set(claimId, authorised_amounts);
  decision = undefined;
  return { said, authorisedAmounts: authorised_amounts };
}

export interface OfferArgs {
  claim_id: string;
  utterance: string;
  authorised_amounts: number[];
}

/**
 * The primary gate. Returns the operator's approved text (`said`) beside
 * the model's original ask (`wanted`) so a console can render the diff, per
 * spec section 2: "the re-fire proves the operator can push back and change
 * the outcome."
 */
export function offerStateSettlement(
  args: OfferArgs,
): { claim_id: string; wanted: string; said: string; authorised_amounts: number[] } {
  const { said, authorisedAmounts } = takeApprovedText(args.claim_id);
  return {
    claim_id: args.claim_id,
    wanted: args.utterance,
    said,
    // From the approved decision (see takeApprovedText), not args: see the
    // doc comment there for why the two can legitimately differ.
    authorised_amounts: authorisedAmounts,
  };
}

export interface AcceptArgs {
  claim_id: string;
  amount: number;
  option: string;
}

/**
 * Spec section 1's DROP FIRST list: a single approval on the offer sentence
 * scopes a pre-authorisation to the amounts inside it, so an amount the
 * caller actually accepted needs no second human click here. TrueForge
 * still gates this tool at the harness level (agent.json), so this check is
 * defence in depth: even a call TrueForge let through only proceeds when
 * the amount matches what a human already saw and approved.
 */
export function settlementAccept(
  args: AcceptArgs,
): { claim_id: string; amount: number; option: string; accepted: true } {
  const authorised = authorisedAmountsByClaim.get(args.claim_id) ?? [];
  if (!isPreAuthorised(args.amount, authorised)) {
    const known = authorised.length > 0 ? authorised.map((a) => a.toFixed(2)).join(', ') : 'none yet';
    throw new Error(
      `settlement.accept: ${args.amount.toFixed(2)} is not one of the amounts authorised for claim ` +
        `${args.claim_id} (${known}). Re-fire offer.state_settlement with a sentence covering this amount.`,
    );
  }
  return { claim_id: args.claim_id, amount: args.amount, option: args.option, accepted: true };
}

let paymentCounter = 0;
const nextPaymentReference = (): string =>
  `PMT-${Date.now().toString(36)}${(paymentCounter++).toString(36).padStart(2, '0')}`;

export interface PaymentArgs {
  claim_id: string;
  amount: number;
  method: string;
}

export function paymentIssue(
  args: PaymentArgs,
): { claim_id: string; amount: number; method: string; status: 'issued'; reference: string } {
  return {
    claim_id: args.claim_id,
    amount: args.amount,
    method: args.method,
    status: 'issued',
    reference: nextPaymentReference(),
  };
}

export interface SalvageReleaseArgs {
  claim_id: string;
  yard_id: string;
}

export function salvageReleaseVehicle(
  args: SalvageReleaseArgs,
): { claim_id: string; yard_id: string; released: true; irreversible: true } {
  return { claim_id: args.claim_id, yard_id: args.yard_id, released: true, irreversible: true };
}

export interface CoverageDenyArgs {
  claim_id: string;
  reason: string;
}

export function coverageDeny(
  args: CoverageDenyArgs,
): { claim_id: string; reason: string; denied: true } {
  return { claim_id: args.claim_id, reason: args.reason, denied: true };
}

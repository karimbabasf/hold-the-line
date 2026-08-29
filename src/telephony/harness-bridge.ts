/**
 * Bridges one caller utterance to a TrueForge session and back.
 *
 * Kept separate from `server.ts` so it can be imported without starting a
 * listener. Deliberately thin: no claim logic lives here, because anything
 * decided on this side of the wire would sit outside the harness and
 * therefore outside the approval gate.
 */

import type { ConsoleEvent } from '../console/events.ts';
import { TrueForgeError } from '../trueforge/client.ts';
import { checkpoint, resume } from '../session/store.ts';
import type { TrueForgeClient } from '../trueforge/client.ts';
import {
  isApprovalRequired,
  isQuestionRequired,
  resolveGate,
  resolveQuestion,
  type ApprovalDecision,
  type ResolvedGate,
  type PendingQuestion,
  type ToolApprovalRequiredEvent,
  type ToolResponseRequiredEvent,
  type TurnInputItem,
} from '../trueforge/types.ts';
import { bindingAmountsFrom, unauthorisedAmounts } from './binding-amounts.ts';
import type { TurnDelta } from './chat-endpoint.ts';
import { createSpeechShaper, type SpeechShaper } from './speech.ts';

export interface BridgeOptions {
  forge: TrueForgeClient;
  agentName: string;
  /** Called when the harness parks a gated tool call, with the tool name and
   *  the draft utterance already resolved off the source event. The console
   *  renders this, so an operator judges the sentence rather than a call id. */
  onApprovalRequired?: (gate: ResolvedGate, callerId: string) => void;
  /**
   * Waits for an operator's decision on a held gate.
   *
   * Resolving to null means no decision was made, and the correct outcome of
   * no decision is silence: the turn speaks nothing further. There is no
   * timeout that approves and no default-allow, because a gate that opens
   * itself is not a gate.
   *
   * Leaving this unset is also fail-closed. The bridge holds, reports the
   * gate, and speaks nothing more that turn.
   */
  awaitApproval?: (
    gate: ResolvedGate,
    callerId: string,
    signal?: AbortSignal,
  ) => Promise<ApprovalDecision | null>;
  /** Called with every console event the bridge emits (call start, session
   *  resume). The server broadcasts these to SSE clients. */
  onConsoleEvent?: (event: ConsoleEvent) => void;
  /** How long after a disconnect a caller can ring back and continue the same
   *  conversation. Ten minutes: long enough for a dropped call and a walk to
   *  better signal, short enough that a stranger on a recycled number does
   *  not inherit somebody's claim. */
  resumeWindowMs?: number;
}

const DEFAULT_RESUME_WINDOW_MS = 10 * 60_000;

/**
 * Pulls speakable text out of a harness event.
 *
 * Verified against a live turn on TrueForge v0.1.4. The stream carries
 * `turn.created`, `model.message`, many `model.message.delta`, then
 * `turn.done`. Only the deltas carry words, in a `content` string, and
 * `model.message` itself is an empty opener that must not be treated as text.
 *
 * Unknown shapes return null rather than throwing, so a new event type in a
 * TrueForge release cannot take a live call down.
 */
export function extractText(event: { type: string; [k: string]: unknown }): string | null {
  if (event.type !== 'model.message.delta') return null;
  const content = event['content'];
  return typeof content === 'string' && content.length > 0 ? content : null;
}

/**
 * True for the empty opener that begins each harness message.
 *
 * One live turn carries several of these, one per tool round, and they are the
 * only signal that the next word starts a new sentence rather than continuing
 * the last one.
 */
export function isMessageStart(event: { type: string }): boolean {
  return event.type === 'model.message';
}

/**
 * The seam between the gate and the voice.
 *
 * The gate decides WHETHER a message may be spoken and the shaper decides
 * HOW it sounds, in that order and never the other way round. The gate reads
 * the harness's own words, so what it judges is what the agent actually
 * asked to say, not a rewritten copy of it.
 *
 * The shaper does change the words: `offer.state_settlement` returns the
 * sentence an operator approved and "$13,481.12" leaves here as "13,481
 * dollars and 12 cents", because raw currency reaches TTS as "dot one two".
 * That rewrite is only ever cosmetic. speech.ts copies digits through
 * untouched and replaces only the symbols around them, so the amount spoken
 * is provably the amount approved. test/approval-gate.test.ts pins that: a
 * shaper that rounded or dropped a digit of an approved figure would be the
 * same class of failure as speaking an unapproved one.
 */
function* speakOut(shaper: SpeechShaper, text: string): Generator<TurnDelta> {
  // Opens this message and releases whatever the last one still held. Only
  // messages that pass the gate ever open, so a withheld message leaves no
  // trace in the shaper's spacing or its filler memory.
  const flushed = shaper.startMessage();
  if (flushed) yield { type: 'message.delta', text: flushed };
  const spoken = shaper.push(text);
  if (spoken) yield { type: 'message.delta', text: spoken };
}

/**
 * True when the harness says the session we asked to continue is gone.
 *
 * The harness is a local process and a restart takes every session with it,
 * while the checkpoint on disk survives. So a stored id outliving its session
 * is ordinary, not exceptional, and the first caller back after a restart
 * must not hear the failure line because of it.
 */
export function isMissingSession(err: unknown): boolean {
  return err instanceof TrueForgeError && err.status === 404;
}

/**
 * What the caller hears when a turn produced nothing speakable at all.
 *
 * Withholding an unapproved figure is right. Ending the turn in silence is
 * not: on the deployed line the caller asked "what is the payout?" and heard
 * nothing back, on the one beat of the call that matters. Dead air reads as
 * a dropped call, and a caller who thinks the line died hangs up.
 *
 * So this is the floor. It states no figure, commits Northvane to nothing,
 * and is true whenever it is said, because it is only ever said when a
 * binding sentence really is waiting on an adjuster. It is deliberately not
 * a paraphrase of whatever was withheld: the agent's blocked sentence never
 * reaches the caller in any form.
 */
const HOLDING_LINE_FIGURE =
  'I need to get that confirmed with the adjuster before I can give you a figure.';

/**
 * The same line for a gate that is not about money.
 *
 * `require_approval_for_tools` also covers salvage.release_vehicle and
 * coverage.deny, and telling a caller their figure is being confirmed while
 * an adjuster decides whether to release their wreck is simply false. The
 * line only works because it is true, so it has to match the gate that is
 * actually open. Found by Qodo.
 */
const HOLDING_LINE_ACTION =
  'I need to get that confirmed with the adjuster before I can go ahead.';

/** The gated tools whose approval is about a number the caller is waiting
 *  on. The rest commit Northvane to an action, not an amount. */
const FIGURE_TOOLS = new Set([
  'offer.state_settlement',
  'settlement.accept',
  'payment.issue',
]);

function holdingLineFor(tools: readonly string[]): string {
  return tools.some((t) => FIGURE_TOOLS.has(t))
    ? HOLDING_LINE_FIGURE
    : HOLDING_LINE_ACTION;
}

/**
 * Hands a withheld sentence back to the agent so it routes it through the
 * gate instead of losing it.
 *
 * A blocked sentence used to vanish. The agent had no way to learn that what
 * it just said never left the building, so it moved on and the caller got
 * silence. This puts the sentence back in front of the agent, inside the
 * same caller turn, with the one instruction that fixes it: call the gated
 * tool. Bracketed like the reconnect cue so the agent reads it as direction
 * rather than as the caller speaking.
 *
 * The sentence is the agent's own words going back to the agent, never to
 * the caller, so returning it here concedes nothing the gate protects.
 */
function redraftCue(sentence: string): string {
  return (
    `[the sentence below was NOT spoken to the caller. It states a settlement ` +
    `figure, which commits Northvane, and nothing binding reaches a caller ` +
    `without an adjuster's approval. Call offer.state_settlement now with ` +
    `this exact sentence as the utterance argument and the figures in it as ` +
    `authorised_amounts, then say back what the tool returns, word for word. ` +
    `Do not state the figure any other way, and do not mention this message ` +
    `to the caller.]\n\n${sentence}`
  );
}

/** State for one caller turn, shared across its gate and redraft rounds. */
interface TurnState {
  /** Sentences the amount guard withheld, newest last. Cleared each redraft
   *  round so the next one answers what the agent just said. */
  withheld: string[];
  /** Redraft rounds already spent on this turn. */
  redrafts: number;
  /**
   * Sticky: this turn had something to say and could not say it.
   *
   * Set when a binding sentence is withheld or a gate goes unanswered, and
   * never cleared. It is what makes the holding line TRUE: it is only ever
   * spoken when a figure really is waiting on an adjuster. A turn where the
   * model simply produced no text is a different thing and gets no line,
   * because there is nothing being confirmed and saying so would be a lie.
   */
  held: boolean;
  /** The line to say if this turn ends with nothing spoken. Set beside
   *  `held` so it always describes why the turn actually went quiet. */
  line: string;
}

/**
 * How many times one turn may be handed back for a redraft.
 *
 * Each round is a whole model turn, so this is seconds of the caller's time.
 * Two is enough for the agent to take the hint and few enough that a model
 * that will not take it reaches the holding line while the caller is still
 * listening.
 */
const MAX_REDRAFT_ROUNDS = 2;

/**
 * How long a gate may sit open before the caller is told why.
 *
 * An operator who clicks straight away should not have their approval
 * talked over, and a caller waiting on a human should not be listening to a
 * line that sounds dead. A beat and a half separates the two.
 *
 * This is a timer that SPEAKS. It cannot approve, deny, or release
 * anything: when it fires, the turn is still waiting on exactly the same
 * human decision it was waiting on before.
 */
const GATE_QUIET_MS = 1_500;

export function createBridge(opts: BridgeOptions) {
  /**
   * One harness session per caller, so a second utterance continues the same
   * conversation instead of starting a new one. Task 6 replaces this map
   * with a disk-backed store that also survives the process.
   */
  /**
   * Live sessions, newest last, bounded.
   *
   * A phone line runs for months and every caller who ever rings adds an
   * entry, so an unbounded map is a slow leak. The disk checkpoint is the
   * real memory; this is only a per-call fast path, so evicting the oldest
   * entry costs a disk read, never a lost conversation.
   */
  const sessions = new Map<string, string>();
  const MAX_LIVE_SESSIONS = 500;
  const resumeWindowMs = opts.resumeWindowMs ?? DEFAULT_RESUME_WINDOW_MS;

  function remember(callerId: string, sessionId: string): void {
    sessions.delete(callerId);
    sessions.set(callerId, sessionId);
    while (sessions.size > MAX_LIVE_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }

  /**
   * Finds the harness session for a caller, in three steps.
   *
   * The in-memory map handles turn-to-turn continuity inside one call. The
   * disk checkpoint handles the case that matters on camera: the line drops,
   * the caller rings back, and the agent picks up the same conversation with
   * the same figures rather than starting over. It also survives a restart of
   * this process, which the map alone did not.
   */
  /** When each caller's call started, for computing event t values. */
  const callStartTimes = new Map<string, number>();

  function callT(callerId: string): number {
    return Date.now() - (callStartTimes.get(callerId) ?? Date.now());
  }

  async function sessionFor(callerId: string): Promise<{ id: string; resumed: boolean; isNew: boolean }> {
    const live = sessions.get(callerId);
    if (live) {
      remember(callerId, live);
      return { id: live, resumed: false, isNew: false };
    }

    // A resume that throws is a resume that did not happen, never a failed
    // call.
    const stored = await resume(callerId, resumeWindowMs).catch(() => null);
    const harnessId = stored?.harness_session_id;
    if (harnessId) {
      remember(callerId, harnessId);
      // Nothing is recomputed. The same run ids come back with it, which is
      // what proves the state survived rather than being regenerated.
      return { id: harnessId, resumed: true, isNew: false };
    }

    const id = await opts.forge.createSession(opts.agentName);
    remember(callerId, id);
    // A failed checkpoint costs a future resume, never the call in progress.
    // Same reason as the one after each turn: the store is a convenience, and
    // a caller must never be dropped because a disk write failed.
    await checkpoint(callerId, { harness_session_id: id, transcript_index: 0 }).catch(
      (err: unknown) => {
        console.warn('could not checkpoint a new session:', err);
      },
    );
    return { id, resumed: false, isNew: true };
  }

  /**
   * Callers whose NEXT turn is their first after a reconnect.
   *
   * This is consumed rather than read, because a latched flag would make
   * every later turn in the call look like a reconnect and the agent would
   * keep welcoming somebody back who never left.
   */
  const pendingResume = new Set<string>();
  function wasResumed(callerId: string): boolean {
    return pendingResume.has(callerId);
  }

  /** Turns completed per caller, so transcript_index means what it says. */
  const turnsSeen = new Map<string, number>();

  /**
   * What each caller's settlement is worth, and which of those figures an
   * operator has let the agent say out loud.
   *
   * Scoped to one call, and cleared when a caller starts a new one. An
   * approval authorises a sentence about one claim, so carrying the amount
   * into a later call would let a figure a human approved last week be
   * spoken about a claim they never saw. That is the same mistake
   * `authorisedAmountsByClaim` in src/mcp/gated.ts was already fixed for
   * once. A resumed call keeps both lists, because it is the same call.
   *
   * Bounded by age rather than by count, for the reason `amountsFor` gives.
   */
  interface CallAmounts {
    /** Last touched, so an entry can be aged out rather than counted out. */
    at: number;
    /** Amounts a tool has said commit Northvane to something. */
    binding: number[];
    /** Of those, the ones an operator has approved. */
    authorised: number[];
  }
  const amountsByCaller = new Map<string, CallAmounts>();

  /**
   * A caller's amounts, aging out entries no live call can still need.
   *
   * Deliberately NOT a count-bounded cache. Evicting the oldest entry would
   * fail OPEN, not closed: with no binding amounts on file there is nothing
   * to compare speech against, so an unapproved figure gets released. And a
   * caller sitting quietly through somebody else's five hundred calls is
   * still on the line. Age is the honest bound instead. Past the resume
   * window the call cannot be picked back up at all, so dropping the entry
   * cannot affect a call in progress.
   */
  function amountsFor(callerId: string): CallAmounts {
    const now = Date.now();
    const found = amountsByCaller.get(callerId) ?? {
      at: now,
      binding: [],
      authorised: [],
    };
    found.at = now;
    amountsByCaller.set(callerId, found);
    for (const [id, entry] of amountsByCaller) {
      if (id !== callerId && now - entry.at > resumeWindowMs) {
        amountsByCaller.delete(id);
      }
    }
    return found;
  }

  /**
   * A question the agent asked and is parked waiting on, per caller.
   *
   * It has to outlive the turn, unlike an approval. An approval is settled
   * by an operator while the caller's stream is still open; a question is
   * answered by the caller SPEAKING, which only reaches us as the next turn.
   * So the parked call id is carried across turns and the next utterance
   * goes back as its answer.
   */
  const questionByCaller = new Map<string, PendingQuestion>();

  /**
   * Checkpoints one completed turn.
   *
   * After every turn rather than on disconnect, because a dropped call gives
   * no disconnect to hook. The line just stops.
   *
   * transcript_index counts TURNS. It previously incremented per streamed
   * event, so one turn of opener plus deltas plus completion recorded as a
   * dozen entries and the resume line pointed at the wrong place.
   */
  async function recordTurn(callerId: string, sessionId: string): Promise<void> {
    turnsSeen.set(callerId, (turnsSeen.get(callerId) ?? 0) + 1);
    await checkpoint(callerId, {
      harness_session_id: sessionId,
      transcript_index: turnsSeen.get(callerId) ?? 1,
    }).catch((err: unknown) => {
      // A failed checkpoint costs a resume, never the call in progress.
      console.warn('checkpoint failed for this turn:', err);
    });
  }

  /** Starts a caller's amounts over. A new call has authorised nothing. */
  function forgetAmounts(callerId: string): void {
    amountsByCaller.delete(callerId);
  }

  /**
   * How many times one caller turn may go round the gate before the bridge
   * stops. A denial makes the agent redraft and ask again, which is the
   * point, but an agent that redrafts forever would recurse forever. Hitting
   * the cap speaks nothing: the failure mode stays silence, never speech.
   */
  const MAX_GATE_ROUNDS = 4;

  /**
   * Streams one turn, holding speech until it is provably safe to say.
   *
   * Two things are held, for two different reasons.
   *
   * Structural: text is buffered per `model.message` and released only when
   * the next message opens or the turn ends clean. A gated call is announced
   * after its message's words have already streamed, so releasing them live
   * would put the agent's own draft in the caller's ear a beat before the
   * operator is even asked. Once an approval is pending nothing further is
   * released at all, whatever the harness goes on to send.
   *
   * By amount: the structural hold only catches sentences the agent routed
   * through a gated tool. Captured live on 2026-08-29, across eight runs of
   * the same caller turn, it did not always route them. Twice the net
   * settlement was stated as prose in a message before the gate, and twice
   * in a turn with no gate at all. So the settlement figure itself is held
   * until an operator authorises it. See binding-amounts.ts.
   */
  async function* runGuarded(
    sessionId: string,
    input: TurnInputItem[],
    callerId: string,
    round: number,
    shaper: SpeechShaper,
    state: TurnState,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnDelta> {
    const { binding, authorised } = amountsFor(callerId);

    /**
     * Text a caller is allowed to hear, or '' when it is not.
     *
     * Withholds the whole message rather than editing the number out of it:
     * a redacted sentence is not a sentence anyone should say on a phone
     * call. A withheld sentence is remembered so it can go back to the agent
     * to be routed through the gate, rather than simply disappearing, which
     * is what left the caller listening to nothing.
     *
     * `remember` is false for a parked question. A question is not an offer,
     * so handing it back with "call offer.state_settlement" would be telling
     * the agent to commit to something it was only asking about.
     */
    const releasable = (text: string, remember = true): string => {
      if (!text) return '';
      const blocked = unauthorisedAmounts(text, binding, authorised);
      if (blocked.length === 0) return text;
      console.error(
        `[gate] withheld speech carrying an unauthorised settlement figure: ${blocked.join(', ')}`,
      );
      state.held = true;
      // A withheld sentence is a withheld amount by construction.
      state.line = HOLDING_LINE_FIGURE;
      if (remember) state.withheld.push(text);
      return '';
    };

    let openMessageId: string | null = null;
    let buffer = '';
    /** Every approval this turn parked on. A list rather than one slot: a
     *  second event would otherwise replace the first and its tool call
     *  would never be shown to an operator or answered, which strands the
     *  turn. Live it is always one, but silence is a bad way to find out
     *  that changed. */
    const pendingEvents: ToolApprovalRequiredEvent[] = [];
    /** A question the agent parked on. Locks speech the same way an approval
     *  does, because whatever else the turn had to say is now behind it. */
    let parkedQuestion: ToolResponseRequiredEvent | null = null;
    const pending = (): boolean =>
      pendingEvents.length > 0 || parkedQuestion !== null;

    for await (const event of opts.forge.streamTurn(sessionId, input, signal)) {
      if (isQuestionRequired(event)) {
        parkedQuestion = event;
        // Whatever was mid-message goes no further, same as a gate: the
        // agent has stopped to ask, so the caller hears the question next.
        buffer = '';
        continue;
      }

      if (isApprovalRequired(event)) {
        // Never auto-approved here. Auto-approving would defeat the entire
        // point of the project.
        pendingEvents.push(event);
        const gated = event.tool_calls.map((c) => c.source_event_id);
        if (openMessageId && !gated.includes(openMessageId)) {
          // Live, the gated call is always the open message, and the turn
          // ends on it. If that ever stops holding, an earlier message has
          // already been spoken and this is the only place it would show.
          console.error(
            `[gate] approval named ${gated.join(', ')} but the open message was ${openMessageId}`,
          );
        }
        // The agent's own draft goes no further.
        buffer = '';
        continue;
      }

      // Speech is locked for the rest of the turn. The live harness ends the
      // turn here, but the lock does not depend on that.
      if (pending()) continue;

      if (event.type === 'tool.response') {
        for (const amount of bindingAmountsFrom(
          (event as { content?: unknown }).content,
        )) {
          if (!binding.includes(amount)) binding.push(amount);
        }
        continue;
      }

      if (event.type === 'model.message') {
        // The previous message closed without a gate, so it can be spoken.
        const out = releasable(buffer);
        if (out) yield* speakOut(shaper, out);
        buffer = '';
        const id = (event as { id?: unknown }).id;
        openMessageId = typeof id === 'string' ? id : null;
        continue;
      }

      const text = extractText(event);
      if (text) buffer += text;
    }

    if (!pending()) {
      const out = releasable(buffer);
      if (out) yield* speakOut(shaper, out);

      // The turn ended with a binding sentence blocked and no gate opened,
      // which is the deployed failure: the agent stated the settlement as
      // ordinary prose, the guard stopped it, and the caller heard nothing.
      // Hand the sentence back so the agent routes it through the gate
      // inside this same turn.
      const sentence = state.withheld.at(-1);
      if (sentence !== undefined && state.redrafts < MAX_REDRAFT_ROUNDS) {
        state.redrafts += 1;
        // Cleared so a second redraft is driven by what the agent said on
        // the retry, never by the sentence that started it.
        state.withheld.length = 0;
        console.warn(
          `[gate] handing a withheld sentence back to the agent, round ${state.redrafts}`,
        );
        yield* runGuarded(
          sessionId,
          [{ type: 'user.message', content: redraftCue(sentence) }],
          callerId,
          round,
          shaper,
          state,
          signal,
        );
      }
      return;
    }

    // A parked question with no approval beside it. Ask it out loud and
    // remember it, so the caller's next utterance answers it rather than
    // hitting the 422 an ordinary message gets while a thread is parked.
    if (pendingEvents.length === 0 && parkedQuestion) {
      const ref = parkedQuestion.tool_calls[0];
      if (!ref) return;
      const source = ref.source_event_id
        ? await opts.forge.findEvent(sessionId, ref.source_event_id)
        : undefined;
      const question = resolveQuestion(ref, parkedQuestion.thread_id, source);
      questionByCaller.set(callerId, question);

      // The question is model-written text on its way to a caller's ear, so
      // it goes through the same check as anything else the agent says.
      if (question.question) {
        const out = releasable(question.question, false);
        if (out) yield* speakOut(shaper, out);
      } else {
        // Nothing to ask means nothing to say. Silence beats inventing a
        // question the agent did not write.
        console.error(
          `[gate] parked on a question whose text could not be read: ${ref.id}`,
        );
      }
      return;
    }

    // Held. Resolve every gate, then wait for every decision, then resume.
    const gates: ResolvedGate[] = [];
    for (const event of pendingEvents) {
      for (const ref of event.tool_calls) {
        const source = ref.source_event_id
          ? await opts.forge.findEvent(sessionId, ref.source_event_id)
          : undefined;
        gates.push(resolveGate(ref, event.thread_id, source));
      }
    }

    // A gate opened at all means this turn has a binding sentence it cannot
    // speak yet, which is exactly when the holding line is true.
    state.held = true;
    state.line = holdingLineFor(gates.map((g) => g.tool));
    // The agent has now routed through the gate, so any prose withheld
    // earlier in this turn is superseded. Leaving it queued made the
    // approved resume redraft a sentence that had already been settled,
    // which spent a model turn, could reopen a gate, and could tack a
    // holding line onto a turn that had just succeeded. Found by Qodo.
    state.withheld.length = 0;

    if (round >= MAX_GATE_ROUNDS) {
      console.error(`[gate] gave up after ${MAX_GATE_ROUNDS} rounds without a settled gate`);
      for (const gate of gates) opts.onApprovalRequired?.(gate, callerId);
      return;
    }

    // Every waiter is installed BEFORE any gate is announced. Announcing
    // first and awaiting one at a time made a gate visible to an operator
    // with nothing yet listening for its answer, so deciding the second of
    // two gates was dropped and that gate then hung. Found by Qodo.
    const decisions = opts.awaitApproval
      ? gates.map((gate) => opts.awaitApproval!(gate, callerId, signal))
      : [];
    for (const gate of gates) opts.onApprovalRequired?.(gate, callerId);

    if (!opts.awaitApproval) {
      console.warn(
        '[gate] held with no approval channel wired. Nothing more is spoken this turn.',
      );
      return;
    }

    // Settle every gate before acting on any of them, so an abandoned
    // waiter cannot outlive the turn that opened it.
    // Tracked separately from the race so the line can be dropped in the gap
    // between the timer firing and the words actually leaving. An operator
    // who approves inside that gap used to get the caller told, 1.7 seconds
    // after their click, that the file "still needs operator approval".
    let alreadyDecided = false;
    const all = Promise.all(decisions).then((d) => {
      alreadyDecided = true;
      return d;
    });

    // Fill the wait. A gate that is open and waiting on a person is the one
    // moment where "getting this confirmed" is exactly true, and it is also
    // the moment the caller was hearing nothing at all: on the deployed line
    // the stream simply stayed open and silent until the far end gave up.
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const spokeSoon = await Promise.race([
      all.then(() => true),
      new Promise<boolean>((r) => {
        quiet = setTimeout(() => r(false), GATE_QUIET_MS);
      }),
    ]);
    clearTimeout(quiet);
    // Never claim an approval is outstanding once it is not.
    if (!spokeSoon && !alreadyDecided) {
      yield* speakOut(shaper, state.line);
    }

    const settled = await all;
    // No decision is not a decision to allow. One undecided gate holds the
    // whole turn, because the turn resumes as one call or not at all.
    if (settled.some((d) => !d)) return;

    const resumeInput: TurnInputItem[] = [];
    gates.forEach((gate, i) => {
      const decision = settled[i] as ApprovalDecision;
      if (decision.status === 'allow') {
        for (const amount of gate.authorised_amounts ?? []) {
          if (!authorised.includes(amount)) authorised.push(amount);
        }
      }
      resumeInput.push({
        type: 'user.tool_approval',
        thread_id: gate.thread_id,
        tool_call_id: gate.tool_call_id,
        approval: decision,
      });
    });

    yield* runGuarded(sessionId, resumeInput, callerId, round + 1, shaper, state, signal);
  }

  return {
    sessions,
    wasResumed,
    async *runTurn(
      userText: string,
      callerId: string,
      signal?: AbortSignal,
    ): AsyncGenerator<TurnDelta> {
      const opened = await sessionFor(callerId);
      let sessionId = opened.id;
      const { resumed, isNew } = opened;

      // Emit console events for session lifecycle changes.
      if (isNew) {
        // A new call starts with nothing authorised, whoever rang last, and
        // with no question outstanding from a call that is over.
        forgetAmounts(callerId);
        questionByCaller.delete(callerId);
        callStartTimes.set(callerId, Date.now());
        opts.onConsoleEvent?.({
          type: 'call', t: 0, status: 'started', caller: callerId,
        });
      }
      if (resumed) {
        pendingResume.add(callerId);
        // The start time is lost across a process restart, so anchor the
        // clock to "now" on resume. The console's syncClockToLive adjusts.
        if (!callStartTimes.has(callerId)) {
          callStartTimes.set(callerId, Date.now());
        }
        opts.onConsoleEvent?.({
          type: 'session', t: callT(callerId), status: 'resumed',
          session_id: sessionId,
        });
      }

      // The cue has to reach the agent, not just sit in a flag the endpoint
      // never reads. Prefixing the turn is what actually produces the
      // "welcome back, you were asking about the payoff" beat, and it is
      // consumed here so only the first turn after a reconnect carries it.
      const isReconnect = pendingResume.delete(callerId);

      // A parked question takes the utterance as its answer. Sending an
      // ordinary message instead is a 422, "user message cannot be sent
      // while approvals or questions are pending", which reached the caller
      // as the endpoint's error line. The answer goes in unprefixed even on
      // a reconnect: the field is an answer to one question, not free prose,
      // and a bracketed stage direction inside it is not what was asked for.
      const parked = questionByCaller.get(callerId);
      if (parked) {
        questionByCaller.delete(callerId);
        const shaper = createSpeechShaper();
        const state: TurnState = {
          withheld: [],
          redrafts: 0,
          held: false,
          line: HOLDING_LINE_FIGURE,
        };
        let saidSomething = false;
        for await (const delta of runGuarded(
          sessionId,
          [
            {
              type: 'user.tool_response',
              thread_id: parked.thread_id,
              tool_call_id: parked.tool_call_id,
              content: userText,
            },
          ],
          callerId,
          0,
          shaper,
          state,
          signal,
        )) {
          saidSomething = true;
          yield delta;
        }
        const answeredTail = shaper.end();
        if (answeredTail) {
          saidSomething = true;
          yield { type: 'message.delta', text: answeredTail };
        }
        if (!saidSomething && state.held) {
          yield { type: 'message.delta', text: state.line };
        }
        await recordTurn(callerId, sessionId);
        return;
      }

      const content = isReconnect
        ? `[the caller was disconnected and has rung back. Continue where you ` +
          `left off, naming the question that was open. Do not greet them again ` +
          `and do not recompute anything.]\n\n${userText}`
        : userText;

      // One shaper per turn. It owns everything between the harness and the
      // caller's ear: the space between two messages, the repeated filler, and
      // the figures. See speech.ts for why each of those is here.
      //
      // It spans the gate rounds too, not just the first pass, because a turn
      // that parks on an approval and resumes is still one turn to the caller:
      // a filler already said before the gate must not be said again after it.
      const shaper = createSpeechShaper();

      // A resumed id can name a session the harness no longer has. Nothing
      // has reached the caller at this point, so a fresh session and one more
      // attempt costs the resume and never the call. Only before the first
      // delta: retrying after speech would say part of the turn twice.
      let spoke = false;
      const state: TurnState = {
          withheld: [],
          redrafts: 0,
          held: false,
          line: HOLDING_LINE_FIGURE,
        };
      try {
        for await (const delta of runGuarded(
          sessionId,
          [{ type: 'user.message', content }],
          callerId,
          0,
          shaper,
          state,
          signal,
        )) {
          spoke = true;
          yield delta;
        }
      } catch (err) {
        if (spoke || !resumed || !isMissingSession(err)) throw err;
        console.warn(
          `resumed session ${sessionId} is gone from the harness, starting a fresh one`,
        );
        sessions.delete(callerId);
        sessionId = await opts.forge.createSession(opts.agentName);
        remember(callerId, sessionId);
        await checkpoint(callerId, {
          harness_session_id: sessionId,
          transcript_index: 0,
        }).catch(() => {});
        // The reconnect cue goes with the session that is gone. There is
        // nothing to continue, so this is the caller's opening line.
        for await (const delta of runGuarded(
          sessionId,
          [{ type: 'user.message', content: userText }],
          callerId,
          0,
          shaper,
          state,
          signal,
        )) {
          spoke = true;
          yield delta;
        }
      }

      const tail = shaper.end();
      if (tail) {
        spoke = true;
        yield { type: 'message.delta', text: tail };
      }

      // The floor. A turn that says nothing is the one outcome a phone call
      // cannot have, and it is what the deployed line did when the guard
      // blocked a figure the agent never routed through the gate.
      if (!spoke && state.held) {
        console.warn('[gate] turn held everything it had to say, speaking the holding line');
        yield { type: 'message.delta', text: state.line };
      }

      await recordTurn(callerId, sessionId);
    },
  };
}

/**
 * Bridges one caller utterance to a TrueForge session and back.
 *
 * Kept separate from `server.ts` so it can be imported without starting a
 * listener. Deliberately thin: no claim logic lives here, because anything
 * decided on this side of the wire would sit outside the harness and
 * therefore outside the approval gate.
 */

import type { ConsoleEvent } from '../console/events.ts';
import { checkpoint, resume } from '../session/store.ts';
import type { TrueForgeClient } from '../trueforge/client.ts';
import {
  isApprovalRequired,
  resolveGate,
  type ApprovalDecision,
  type ResolvedGate,
  type ToolApprovalRequiredEvent,
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
   * Bounded for the same reason `sessions` is: a phone line runs for months
   * and every caller who ever rings would otherwise add an entry that is
   * never removed.
   */
  const bindingByCaller = new Map<string, number[]>();
  const authorisedByCaller = new Map<string, number[]>();
  const listFor = (m: Map<string, number[]>, callerId: string): number[] => {
    const existing = m.get(callerId);
    if (existing) return existing;
    const fresh: number[] = [];
    m.set(callerId, fresh);
    while (m.size > MAX_LIVE_SESSIONS) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
    return fresh;
  };

  /** Starts a caller's amounts over. A new call has authorised nothing. */
  function forgetAmounts(callerId: string): void {
    bindingByCaller.delete(callerId);
    authorisedByCaller.delete(callerId);
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
  ): AsyncGenerator<TurnDelta> {
    const binding = listFor(bindingByCaller, callerId);
    const authorised = listFor(authorisedByCaller, callerId);

    /** Text a caller is allowed to hear, or '' when it is not. Withholds the
     *  whole message rather than editing the number out of it: a redacted
     *  sentence is not a sentence anyone should say on a phone call. */
    const releasable = (text: string): string => {
      if (!text) return '';
      const blocked = unauthorisedAmounts(text, binding, authorised);
      if (blocked.length === 0) return text;
      console.error(
        `[gate] withheld speech carrying an unauthorised settlement figure: ${blocked.join(', ')}`,
      );
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
    const pending = (): boolean => pendingEvents.length > 0;

    for await (const event of opts.forge.streamTurn(sessionId, input)) {
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
      return;
    }

    // Held. Describe every gate, wait for every decision, resume only when
    // all of them came back.
    const gates: ResolvedGate[] = [];
    for (const event of pendingEvents) {
      for (const ref of event.tool_calls) {
        const source = ref.source_event_id
          ? await opts.forge.findEvent(sessionId, ref.source_event_id)
          : undefined;
        const gate = resolveGate(ref, event.thread_id, source);
        gates.push(gate);
        opts.onApprovalRequired?.(gate, callerId);
      }
    }

    if (!opts.awaitApproval) {
      console.warn(
        '[gate] held with no approval channel wired. Nothing more is spoken this turn.',
      );
      return;
    }
    if (round >= MAX_GATE_ROUNDS) {
      console.error(`[gate] gave up after ${MAX_GATE_ROUNDS} rounds without a settled gate`);
      return;
    }

    const resumeInput: TurnInputItem[] = [];
    for (const gate of gates) {
      const decision = await opts.awaitApproval(gate, callerId);
      // No decision is not a decision to allow. Speak nothing.
      if (!decision) return;
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
    }

    yield* runGuarded(sessionId, resumeInput, callerId, round + 1, shaper);
  }

  return {
    sessions,
    wasResumed,
    async *runTurn(userText: string, callerId: string): AsyncGenerator<TurnDelta> {
      const { id: sessionId, resumed, isNew } = await sessionFor(callerId);

      // Emit console events for session lifecycle changes.
      if (isNew) {
        // A new call starts with nothing authorised, whoever rang last.
        forgetAmounts(callerId);
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

      yield* runGuarded(
        sessionId,
        [{ type: 'user.message', content }],
        callerId,
        0,
        shaper,
      );

      const tail = shaper.end();
      if (tail) yield { type: 'message.delta', text: tail };

      // Checkpoint after every turn rather than on disconnect, because a
      // dropped call gives no disconnect to hook. The line just stops.
      //
      // transcript_index counts TURNS. It previously incremented per streamed
      // event, so one turn of opener plus deltas plus completion recorded as
      // a dozen entries and the resume line pointed at the wrong place.
      turnsSeen.set(callerId, (turnsSeen.get(callerId) ?? 0) + 1);
      await checkpoint(callerId, {
        harness_session_id: sessionId,
        transcript_index: turnsSeen.get(callerId) ?? 1,
      }).catch((err: unknown) => {
        // A failed checkpoint costs a resume, never the call in progress.
        console.warn('checkpoint failed for this turn:', err);
      });
    },
  };
}

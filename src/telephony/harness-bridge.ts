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
import { isApprovalRequired, type ToolApprovalRequiredEvent } from '../trueforge/types.ts';
import type { TurnDelta } from './chat-endpoint.ts';

export interface BridgeOptions {
  forge: TrueForgeClient;
  agentName: string;
  /** Called when the harness parks a gated tool call. Receives the full
   *  approval event and the caller id so the console can build a gate event
   *  with the right tool name and timing. */
  onApprovalRequired?: (event: ToolApprovalRequiredEvent, callerId: string) => void;
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

  return {
    sessions,
    wasResumed,
    async *runTurn(userText: string, callerId: string): AsyncGenerator<TurnDelta> {
      const { id: sessionId, resumed, isNew } = await sessionFor(callerId);

      // Emit console events for session lifecycle changes.
      if (isNew) {
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

      for await (const event of opts.forge.streamTurn(sessionId, [
        { type: 'user.message', content },
      ])) {
        if (isApprovalRequired(event)) {
          // Never auto-approved here. Auto-approving would defeat the entire
          // point of the project.
          opts.onApprovalRequired?.(event, callerId);
          continue;
        }

        const text = extractText(event);
        if (text) yield { type: 'message.delta', text };
      }

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

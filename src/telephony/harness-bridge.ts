/**
 * Bridges one caller utterance to a TrueForge session and back.
 *
 * Kept separate from `server.ts` so it can be imported without starting a
 * listener. Deliberately thin: no claim logic lives here, because anything
 * decided on this side of the wire would sit outside the harness and
 * therefore outside the approval gate.
 */

import { checkpoint, resume } from '../session/store.ts';
import type { TrueForgeClient } from '../trueforge/client.ts';
import { isApprovalRequired } from '../trueforge/types.ts';
import type { TurnDelta } from './chat-endpoint.ts';

export interface BridgeOptions {
  forge: TrueForgeClient;
  agentName: string;
  /** Called when the harness parks a gated tool call. Task 5 routes this to
   *  the operator console. It is never auto-approved. */
  onApprovalRequired?: (toolCalls: unknown) => void;
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
  const sessions = new Map<string, string>();
  const resumeWindowMs = opts.resumeWindowMs ?? DEFAULT_RESUME_WINDOW_MS;

  /**
   * Finds the harness session for a caller, in three steps.
   *
   * The in-memory map handles turn-to-turn continuity inside one call. The
   * disk checkpoint handles the case that matters on camera: the line drops,
   * the caller rings back, and the agent picks up the same conversation with
   * the same figures rather than starting over. It also survives a restart of
   * this process, which the map alone did not.
   */
  async function sessionFor(callerId: string): Promise<{ id: string; resumed: boolean }> {
    const live = sessions.get(callerId);
    if (live) return { id: live, resumed: false };

    // A resume that throws is a resume that did not happen, never a failed
    // call.
    const stored = await resume(callerId, resumeWindowMs).catch(() => null);
    const harnessId = stored?.harness_session_id;
    if (harnessId) {
      sessions.set(callerId, harnessId);
      // Nothing is recomputed. The same run ids come back with it, which is
      // what proves the state survived rather than being regenerated.
      return { id: harnessId, resumed: true };
    }

    const id = await opts.forge.createSession(opts.agentName);
    sessions.set(callerId, id);
    // A failed checkpoint costs a future resume, never the call in progress.
    // Same reason as the one after each turn: the store is a convenience, and
    // a caller must never be dropped because a disk write failed.
    await checkpoint(callerId, { harness_session_id: id, transcript_index: 0 }).catch(
      (err: unknown) => {
        console.warn('could not checkpoint a new session:', err);
      },
    );
    return { id, resumed: false };
  }

  /** True when this caller's last turn came back from a checkpoint. Lets the
   *  endpoint open with a resume line instead of a greeting. */
  const resumedCallers = new Set<string>();
  function wasResumed(callerId: string): boolean {
    return resumedCallers.has(callerId);
  }

  return {
    sessions,
    wasResumed,
    async *runTurn(userText: string, callerId: string): AsyncGenerator<TurnDelta> {
      const { id: sessionId, resumed } = await sessionFor(callerId);
      if (resumed) resumedCallers.add(callerId);

      let turns = 0;
      for await (const event of opts.forge.streamTurn(sessionId, [
        { type: 'user.message', content: userText },
      ])) {
        turns += 1;
        if (isApprovalRequired(event)) {
          // Never auto-approved here. Auto-approving would defeat the entire
          // point of the project.
          opts.onApprovalRequired?.(event.tool_calls);
          continue;
        }

        const text = extractText(event);
        if (text) yield { type: 'message.delta', text };
      }

      // Checkpoint after every turn rather than on disconnect, because a
      // dropped call gives no disconnect to hook. The line just stops.
      await checkpoint(callerId, {
        harness_session_id: sessionId,
        transcript_index: turns,
      }).catch((err: unknown) => {
        // A failed checkpoint costs a resume, never the call in progress.
        console.warn('checkpoint failed for this turn:', err);
      });
    },
  };
}

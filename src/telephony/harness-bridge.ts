/**
 * Bridges one caller utterance to a TrueForge session and back.
 *
 * Kept separate from `server.ts` so it can be imported without starting a
 * listener. Deliberately thin: no claim logic lives here, because anything
 * decided on this side of the wire would sit outside the harness and
 * therefore outside the approval gate.
 */

import type { TrueForgeClient } from '../trueforge/client.ts';
import { isApprovalRequired } from '../trueforge/types.ts';
import type { TurnDelta } from './chat-endpoint.ts';

export interface BridgeOptions {
  forge: TrueForgeClient;
  agentName: string;
  /** Called when the harness parks a gated tool call. Task 5 routes this to
   *  the operator console. It is never auto-approved. */
  onApprovalRequired?: (toolCalls: unknown) => void;
}

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

  async function sessionFor(callerId: string): Promise<string> {
    const existing = sessions.get(callerId);
    if (existing) return existing;
    const id = await opts.forge.createSession(opts.agentName);
    sessions.set(callerId, id);
    return id;
  }

  return {
    sessions,
    async *runTurn(userText: string, callerId: string): AsyncGenerator<TurnDelta> {
      const sessionId = await sessionFor(callerId);

      for await (const event of opts.forge.streamTurn(sessionId, [
        { type: 'user.message', content: userText },
      ])) {
        if (isApprovalRequired(event)) {
          // Never auto-approved here. Auto-approving would defeat the entire
          // point of the project.
          opts.onApprovalRequired?.(event.tool_calls);
          continue;
        }

        const text = extractText(event);
        if (text) yield { type: 'message.delta', text };
      }
    },
  };
}

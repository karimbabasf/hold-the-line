/**
 * Wire types for the TrueForge agent API (v1).
 *
 * Only the parts this project depends on are modelled. Everything else in a
 * turn event stream is passed through as UnknownEvent so an unrecognised
 * event type can never crash the caller.
 */

export type ApprovalDecision =
  | { status: 'allow' }
  | { status: 'deny'; reason?: string };

/** A tool call the harness is holding until a human decides. */
export interface ToolCallRef {
  id: string;
  name?: string;
  arguments?: unknown;
}

/** Emitted when one or more tool calls need human approval. */
export interface ToolApprovalRequiredEvent {
  type: 'tool.approval_required';
  id: string;
  created_at: string;
  thread_id: string;
  tool_calls: ToolCallRef[];
}

/** Sent back to resume a turn that is parked on an approval. */
export interface UserToolApprovalInput {
  type: 'user.tool_approval';
  thread_id: string;
  tool_call_id: string;
  approval: ApprovalDecision;
}

export interface UserMessageInput {
  type: 'user.message';
  content: string;
}

export type TurnInputItem = UserMessageInput | UserToolApprovalInput;

export interface UnknownEvent {
  type: string;
  [key: string]: unknown;
}

export type TurnEvent = ToolApprovalRequiredEvent | UnknownEvent;

/**
 * Narrows to an approval event, checking the fields the caller then uses.
 *
 * Matching on `type` alone hands back an object whose `thread_id` and
 * `tool_calls` are typed as present and may not be, and the resume call built
 * from them fails far from here with an unrelated server error.
 */
export function isApprovalRequired(e: TurnEvent): e is ToolApprovalRequiredEvent {
  if (e.type !== 'tool.approval_required') return false;

  const { thread_id: threadId, tool_calls: toolCalls } = e as Partial<ToolApprovalRequiredEvent>;
  return (
    typeof threadId === 'string' &&
    threadId.length > 0 &&
    Array.isArray(toolCalls) &&
    toolCalls.every((c) => typeof c?.id === 'string' && c.id.length > 0)
  );
}

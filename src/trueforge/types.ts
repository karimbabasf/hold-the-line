/**
 * Wire types for the TrueForge agent API (v1).
 *
 * Only the parts this project depends on are modelled. Everything else in a
 * turn event stream is passed through as UnknownEvent so an unrecognised
 * event type can never crash the caller.
 *
 * The approval shapes below were captured from a live harness on
 * 2026-08-29, not written from the docs. The previous versions of them were
 * wrong in a way that reached the operator: every gate arrived at the
 * console as `tool: "unknown"` with no draft utterance, so an operator was
 * asked to approve a sentence they could not see.
 */

export type ApprovalDecision =
  | { status: 'allow' }
  | { status: 'deny'; reason?: string };

/**
 * A tool call the harness is holding until a human decides.
 *
 * The live event carries these two fields and nothing else:
 *
 *   [{"id":"call_pfUmambJfpISErJ9rcIYMHui",
 *     "source_event_id":"01m174w4e8t51h8eywg73y9dt1"}]
 *
 * There is no `name` here and no `arguments`. Both live on the
 * `model.message` that `source_event_id` points at. See `resolveGate`.
 */
export interface ToolCallRef {
  id: string;
  source_event_id?: string;
}

/** Emitted when one or more tool calls need human approval. */
export interface ToolApprovalRequiredEvent {
  type: 'tool.approval_required';
  id: string;
  created_at: string;
  thread_id: string;
  tool_calls: ToolCallRef[];
}

/**
 * One entry in a `model.message`'s `tool_calls`.
 *
 * `function.name` is always the literal string `call_tool`: TrueForge wraps
 * every MCP tool in one envelope. The tool the operator cares about is
 * inside `function.arguments`, which is a JSON *string*, not an object.
 */
export interface ModelToolCall {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * The `model.message` that `source_event_id` points at.
 *
 * The copy that arrives on the SSE stream is an empty opener: it carries an
 * id and no `tool_calls`. Only the persisted copy, from
 * `GET /api/v1/sessions/{id}/events`, carries the call. That is why
 * resolving a gate needs a fetch and cannot be done from the stream alone.
 */
export interface ModelMessageEvent {
  type: string;
  id: string;
  content?: string;
  tool_calls?: ModelToolCall[];
}

/** What `call_tool` carries once its `arguments` string is parsed. */
export interface CallToolArguments {
  mcp_server?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
}

/** A gate with the tool name and draft utterance an operator has to see. */
export interface ResolvedGate {
  /** TrueForge's id for the held call. Also the console's gate id. */
  tool_call_id: string;
  thread_id: string;
  /** The real MCP tool, e.g. `offer.state_settlement`. `unknown` only when
   *  the source event could not be read, never a guess. */
  tool: string;
  /** The sentence the agent wants to say. */
  utterance?: string;
  claim_id?: string;
  /** Amounts this offer would authorise, so an approval makes exactly those
   *  figures speakable and no others. */
  authorised_amounts?: number[];
}

/**
 * Pulls the real tool name and draft utterance off the source event.
 *
 * Falls back to `unknown` rather than to the envelope's own `name`, which
 * is always `call_tool` and would tell an operator nothing. A gate an
 * operator cannot read is a gate they cannot judge, so an unresolved one is
 * reported as unresolved.
 */
export function resolveGate(
  ref: ToolCallRef,
  threadId: string,
  source: ModelMessageEvent | undefined,
): ResolvedGate {
  const base: ResolvedGate = {
    tool_call_id: ref.id,
    thread_id: threadId,
    tool: 'unknown',
  };
  const call = (source?.tool_calls ?? []).find((c) => c.id === ref.id);
  if (!call?.function?.arguments) return base;

  let args: CallToolArguments;
  try {
    args = JSON.parse(call.function.arguments) as CallToolArguments;
  } catch {
    return base;
  }

  const input = args.input ?? {};
  const utterance = input['utterance'];
  const claimId = input['claim_id'];
  const amounts = input['authorised_amounts'];

  return {
    ...base,
    ...(typeof args.tool_name === 'string' && args.tool_name
      ? { tool: args.tool_name }
      : {}),
    ...(typeof utterance === 'string' ? { utterance } : {}),
    ...(typeof claimId === 'string' ? { claim_id: claimId } : {}),
    ...(Array.isArray(amounts) &&
    amounts.every((a) => typeof a === 'number' && Number.isFinite(a))
      ? { authorised_amounts: amounts as number[] }
      : {}),
  };
}

/**
 * Emitted when the agent asks the caller something through
 * `ask_user_question` and parks the thread waiting for the answer.
 *
 * Captured live on 2026-08-29. The shape is the approval's shape exactly:
 *
 *   {"type":"tool.response_required","id":"01m1778vb9kn187m3kha9qqx2m",
 *    "created_at":"2026-08-29T16:57:28.169Z","thread_id":"main",
 *    "tool_calls":[{"id":"call_vqgE8dQFc9PqamUyPtVHMMtf",
 *                   "source_event_id":"01m1778sk9jwsr0w2jj54tyc3y"}]}
 *
 * Two things follow from it, and both were live faults. The turn speaks NO
 * text at all, so the question exists only inside the tool call and a caller
 * hears silence. And while it is parked the API refuses an ordinary message:
 *
 *   422 {"error":{"message":"thread main: user message cannot be sent while
 *        approvals or questions are pending"}}
 *
 * so the caller's answer came back as an error and the endpoint spoke its
 * fallback line.
 */
export interface ToolResponseRequiredEvent {
  type: 'tool.response_required';
  id: string;
  created_at: string;
  thread_id: string;
  tool_calls: ToolCallRef[];
}

/** A question the agent is waiting on, with the words to say out loud. */
export interface PendingQuestion {
  tool_call_id: string;
  thread_id: string;
  /** The sentence to ask the caller. Empty when the source event could not
   *  be read, which is the one case where nothing can be asked. */
  question: string;
  /** Choices the agent offered, if any. Usually empty on a phone call. */
  options: string[];
}

export function isQuestionRequired(e: TurnEvent): e is ToolResponseRequiredEvent {
  if (e.type !== 'tool.response_required') return false;
  const { thread_id: threadId, tool_calls: toolCalls } =
    e as Partial<ToolResponseRequiredEvent>;
  return (
    typeof threadId === 'string' &&
    threadId.length > 0 &&
    Array.isArray(toolCalls) &&
    toolCalls.every((c) => typeof c?.id === 'string' && c.id.length > 0)
  );
}

/**
 * Pulls the question text off the source event.
 *
 * Same envelope as a gated call and a different name inside it. The tool is
 * `ask_user_question`, singular, and its `arguments` is a JSON string
 * carrying `{question, options}` rather than the `{mcp_server, tool_name,
 * input}` a `call_tool` carries.
 */
export function resolveQuestion(
  ref: ToolCallRef,
  threadId: string,
  source: ModelMessageEvent | undefined,
): PendingQuestion {
  const base: PendingQuestion = {
    tool_call_id: ref.id,
    thread_id: threadId,
    question: '',
    options: [],
  };
  const call = (source?.tool_calls ?? []).find((c) => c.id === ref.id);
  if (!call?.function?.arguments) return base;

  let args: { question?: unknown; options?: unknown };
  try {
    args = JSON.parse(call.function.arguments) as typeof args;
  } catch {
    return base;
  }
  return {
    ...base,
    ...(typeof args.question === 'string' ? { question: args.question } : {}),
    ...(Array.isArray(args.options)
      ? { options: args.options.filter((o): o is string => typeof o === 'string') }
      : {}),
  };
}

/** Sent back to resume a turn that is parked on an approval. */
export interface UserToolApprovalInput {
  type: 'user.tool_approval';
  thread_id: string;
  tool_call_id: string;
  approval: ApprovalDecision;
}

/**
 * Sent back to answer a parked question.
 *
 * The field is `content`. Verified live: `response`, `output`, `result` and
 * `answers` are all rejected with "expected string, received undefined at
 * input[0].content".
 */
export interface UserToolResponseInput {
  type: 'user.tool_response';
  thread_id: string;
  tool_call_id: string;
  content: string;
}

export interface UserMessageInput {
  type: 'user.message';
  content: string;
}

export type TurnInputItem =
  | UserMessageInput
  | UserToolApprovalInput
  | UserToolResponseInput;

export interface UnknownEvent {
  type: string;
  [key: string]: unknown;
}

export type TurnEvent =
  | ToolApprovalRequiredEvent
  | ToolResponseRequiredEvent
  | UnknownEvent;

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

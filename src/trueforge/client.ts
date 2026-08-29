/**
 * Client for the TrueForge agent API.
 *
 * The one operation this project actually turns on is the approval loop:
 * the harness parks a gated tool call, emits `tool.approval_required`, and
 * waits. A human decides. We resume the same thread with the decision.
 *
 * Note there is no "allow but change the arguments" on the wire. An operator
 * who wants different wording denies with a reason, and the agent redrafts
 * and asks again. That is a deliberate property, not a limitation: the words
 * the caller hears are always words the agent composed and a human passed,
 * never words spliced in behind the agent's back.
 */

import { parseSse } from './sse.ts';
import type { ApprovalDecision, TurnEvent, TurnInputItem } from './types.ts';

export interface TrueForgeClientOptions {
  baseUrl?: string;
  /** Abort any single request that has not responded in this many ms. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TrueForgeError extends Error {
  // Written out rather than declared as constructor parameter properties.
  // Node's --experimental-strip-types removes types without emitting code,
  // so `constructor(readonly status: number)` throws
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at load time.
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'TrueForgeError';
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_BASE_URL = 'http://localhost:8790';
const DEFAULT_TIMEOUT_MS = 30_000;

export class TrueForgeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TrueForgeClientOptions = {}) {
    // Trailing slashes would produce `//api/v1/...`, which some routers treat
    // as a different path.
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Creates a session bound to a stored agent definition.
   *
   * The reference is by NAME. `{ agent: { id } }` is rejected with a bare
   * "Invalid input at agent" that does not say which field is wrong, so the
   * parameter is named `agentName` to stop anyone passing the id that
   * `POST /api/v1/agents` hands back.
   */
  async createSession(agentName: string): Promise<string> {
    const body = await this.json<{ data?: { id?: string }; id?: string }>(
      'POST',
      '/api/v1/sessions',
      { agent: { name: agentName } },
    );
    const id = body.data?.id ?? body.id;
    if (!id) throw new Error('createSession: response carried no session id');
    return id;
  }

  /**
   * Sends turn input and yields each event as it arrives.
   *
   * The caller drives the loop, so a `tool.approval_required` event surfaces
   * the moment the harness parks, rather than after the turn completes.
   */
  async *streamTurn(
    sessionId: string,
    input: TurnInputItem[],
    signal?: AbortSignal,
  ): AsyncGenerator<TurnEvent> {
    assertHomogeneousInput(input);

    const res = await this.request(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
      { input, stream: true },
      signal,
    );

    if (!res.body) throw new Error('streamTurn: response carried no body');

    for await (const frame of parseSse(res.body)) {
      // The stream terminates with a literal sentinel rather than EOF.
      if (frame.data === '[DONE]') return;

      let event: TurnEvent;
      try {
        event = JSON.parse(frame.data) as TurnEvent;
      } catch {
        // A malformed frame is worth skipping, never worth killing a live
        // call over.
        continue;
      }
      if (typeof event?.type === 'string') yield event;
    }
  }

  /** Resumes a turn parked on an approval. */
  async *resolveApproval(
    sessionId: string,
    threadId: string,
    toolCallId: string,
    decision: ApprovalDecision,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnEvent> {
    yield* this.streamTurn(
      sessionId,
      [
        {
          type: 'user.tool_approval',
          thread_id: threadId,
          tool_call_id: toolCallId,
          approval: decision,
        },
      ],
      signal,
    );
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.request(method, path, body);
    return (await res.json()) as T;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    // A caller-supplied signal and our own timeout both have to be able to
    // abort, so they are combined rather than one overriding the other.
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: combined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new TrueForgeError(
        `${method} ${path} failed with ${res.status}`,
        res.status,
        text,
      );
    }
    return res;
  }
}

/**
 * The API rejects a turn that mixes user messages with approval resumes, and
 * the resulting server error does not say why. Failing here keeps the reason
 * attached to the mistake.
 */
function assertHomogeneousInput(input: TurnInputItem[]): void {
  if (input.length === 0) throw new Error('turn input must not be empty');

  const hasMessage = input.some((i) => i.type === 'user.message');
  const hasApproval = input.some((i) => i.type === 'user.tool_approval');
  if (hasMessage && hasApproval) {
    throw new Error(
      'turn input must not mix user messages with approval resumes',
    );
  }
}

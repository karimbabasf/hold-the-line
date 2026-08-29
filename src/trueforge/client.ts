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
import type {
  ApprovalDecision,
  ModelMessageEvent,
  TurnEvent,
  TurnInputItem,
} from './types.ts';

export interface TrueForgeClientOptions {
  baseUrl?: string;
  /** Abort any single request that has not responded in this many ms. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TrueForgeError extends Error {
  // Written out rather than declared as constructor parameter properties.
  // Node's --experimental-strip-types removes types without emitting code, so
  // `constructor(readonly status: number)` throws
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at load time. It typechecks clean and
  // crashes on import, which is why test/loadable.test.ts exists.
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

    const res = await this.stream(
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

  /**
   * Reads one persisted event back out of a session.
   *
   * A gated call's tool name and draft utterance are not on the approval
   * event and are not on the streamed `model.message` either: the streamed
   * copy is an empty opener carrying only an id. Only the persisted copy
   * carries `tool_calls`, so resolving a gate means coming back for it.
   *
   * The listing is newest first, verified live on 2026-08-29: for a gate
   * that just fired, its source event sits two entries down, behind
   * `turn.done` and the approval itself. A short page is therefore enough
   * however long the call has run, and is cheap enough to sit inside a turn.
   *
   * Returns undefined rather than throwing. A gate that cannot be described
   * is still a gate that must be held, so a failed read must degrade into
   * "the operator sees an unresolved gate", never into a call that drops or
   * a call that speaks.
   */
  async findEvent(
    sessionId: string,
    eventId: string,
    limit = 20,
  ): Promise<ModelMessageEvent | undefined> {
    try {
      const body = await this.json<{ data?: Array<{ event?: ModelMessageEvent }> }>(
        'GET',
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/events?limit=${limit}`,
      );
      return (body.data ?? [])
        .map((w) => w?.event)
        .find((e): e is ModelMessageEvent => e?.id === eventId);
    } catch (err) {
      console.warn('could not read the event behind a gate:', err);
      return undefined;
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

  /**
   * Sends a request whose body is finite, and reads it under the deadline.
   *
   * The body is consumed here rather than handed back, so the timer can stay
   * live across the read without cloning the response to observe it.
   */
  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.send(method, path, body, undefined, async (res, timer) => {
      try {
        return (await res.json()) as T;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /**
   * Sends a request whose body is a long-lived stream.
   *
   * The timer is cleared once headers arrive, because the whole point is that
   * an SSE turn may legitimately outlive it. From there the caller's own
   * signal governs the body.
   */
  private async stream(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.send(method, path, body, signal, (res, timer) => {
      clearTimeout(timer);
      return Promise.resolve(res);
    });
  }

  /**
   * The shared request path.
   *
   * Two things must both hold and they pull in opposite directions. A 30
   * second timeout attached to the whole response lifetime kills an SSE turn
   * mid-call, which is the failure this project cannot have: a caller on hold
   * while the agent is thinking. But clearing it at headers for every request
   * leaves a finite read with no deadline, so a server that sends headers and
   * stalls its body hangs forever. Both were live bugs, both caught by review.
   *
   * So the caller decides when the timer dies, via `settle`.
   */
  private async send<T>(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    settle: (res: Response, timer: ReturnType<typeof setTimeout>) => Promise<T>,
  ): Promise<T> {
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(new Error(`no response within ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream, application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined,
      });
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }

    if (!res.ok) {
      // An error body is finite whichever kind of request this was, so it is
      // read under the deadline.
      let text = '';
      try {
        text = await res.text();
      } catch {
        text = '';
      } finally {
        clearTimeout(timer);
      }
      throw new TrueForgeError(`${method} ${path} failed with ${res.status}`, res.status, text);
    }

    return settle(res, timer);
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

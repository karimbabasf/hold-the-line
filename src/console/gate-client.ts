/**
 * The operator's half of the gate.
 *
 * `console.ts` rendered the draft, the breakdown and three buttons, and the
 * buttons posted nowhere: there was no `fetch` in the console at all. While
 * the gate did not really hold, that only meant a click changed the screen
 * and the caller heard the figure regardless. Now that the gate holds, it
 * means a caller listening to silence with nobody able to release them.
 *
 * The wire is the one the telephony process already serves: `POST
 * /gate/decide` with `{id, status: "allow" | "deny", reason?}`, carrying the
 * same shared secret as the chat endpoint. Two statuses and no third, so
 * this module cannot express a decision the server would not settle.
 *
 * The rule the whole file is built around: a binding sentence is spoken
 * because a person clicked, and for no other reason. There is no timer here,
 * no retry, and no error path that falls through to an approval. An approval
 * happens when, and only when, `approve()` is called.
 *
 * The token is read through a getter rather than held, so the page never
 * bakes one in. The console asks the operator for it and keeps it in
 * `sessionStorage`: this listener is on a public tunnel, so anything served
 * from it is served to whoever finds the tunnel, and a secret that can
 * decide what a caller hears cannot travel in a page.
 *
 * No DOM here on purpose. `console.ts` only runs in a browser, so anything
 * left inside it cannot be tested at all.
 */

/** Exactly what the server settles a gate on. There is no third status. */
export type GateRequest =
  | { id: string; status: 'allow' }
  | { id: string; status: 'deny'; reason: string };

export type GateResult = { ok: true } | { ok: false; error: string };

export interface GateClientOptions {
  /** Reads the operator's token at call time. Null when none is stored. */
  token: () => string | null;
  /** Where `/gate/decide` lives. Same origin as the console by default. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINT = '/gate/decide';

function messageFor(status: number, payload: unknown): string {
  const stated = (payload as { error?: unknown } | null)?.error;
  if (status === 401) return 'the operator token was rejected. check it and try again.';
  if (typeof stated === 'string' && stated !== '') return stated;
  return `the server answered ${status}.`;
}

export function createGateClient(options: GateClientOptions) {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const doFetch = options.fetchImpl ?? fetch;

  async function send(request: GateRequest): Promise<GateResult> {
    const token = options.token();
    if (!token) {
      return { ok: false, error: 'No operator key yet. Set it in the bar at the bottom of the screen.' };
    }

    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(request),
      });
    } catch {
      // Never retried. A retry is a second attempt at speaking a binding
      // sentence that the operator has not been told failed, and this side
      // cannot tell a request that never arrived from one that arrived and
      // whose answer was lost.
      return { ok: false, error: 'could not reach the telephony process.' };
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) return { ok: false, error: messageFor(response.status, payload) };
    return { ok: true };
  }

  return {
    /** Releases one gate. The only call in this module that sends an allow. */
    approve(id: string): Promise<GateResult> {
      return send({ id, status: 'allow' });
    },

    /**
     * Sends one gate back for a redraft.
     *
     * The reason is required, and checked here rather than at the server,
     * because the agent reads it to write the next draft. A send back with
     * nothing in it produces the same sentence again and the operator clicks
     * the same button a second time.
     */
    sendBack(id: string, reason: string): Promise<GateResult> {
      const trimmed = reason.trim();
      if (trimmed === '') {
        return Promise.resolve({
          ok: false,
          error: 'say why. the agent redrafts from this reason.',
        });
      }
      return send({ id, status: 'deny', reason: trimmed });
    },
  };
}

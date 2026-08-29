/**
 * The process Telnyx talks to.
 *
 * Entrypoint only. All behaviour lives in `chat-endpoint.ts` and
 * `harness-bridge.ts` so it can be tested without binding a port.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TrueForgeClient } from '../trueforge/client.ts';
import type { ApprovalDecision, ResolvedGate } from '../trueforge/types.ts';
import { createChatEndpoint } from './chat-endpoint.ts';
import { createBridge } from './harness-bridge.ts';
import { createLiveConsole } from './live-console.ts';
import { createNodeHandler, createRouter } from './router.ts';

/**
 * The endpoint is on a public tunnel, so it authenticates.
 *
 * Without this, the `user` field in the body is an unauthenticated session
 * key: anyone who finds the tunnel can pass another caller's number and
 * resume their claim session, reading everything already computed on it.
 * Telnyx sends this as a bearer token from its integration secret.
 */
const SHARED_SECRET = process.env.TELEPHONY_SHARED_SECRET;
if (!SHARED_SECRET) {
  console.error('TELEPHONY_SHARED_SECRET is not set. Refusing to serve an unauthenticated endpoint.');
  process.exit(1);
}

/** One caller utterance is a few hundred bytes. 64KB is generous and stops a
 *  single request eating memory on a public listener. */
const MAX_BODY_BYTES = 64 * 1024;

const CONSOLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'console');

const PORT = Number(process.env.PORT ?? 8791);
const AGENT_NAME = process.env.TRUEFORGE_AGENT ?? 'northvane';
const TRUEFORGE_BASE_URL = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';

/**
 * The console's live end.
 *
 * `CONSOLE_INGEST_SECRET` is what the tool process on 8792 presents to write
 * events onto an operator's screen. It is required, not optional: this
 * listener is on a public tunnel, so an open ingest route would let anyone
 * who found the tunnel put whatever figures they liked in front of an
 * adjuster. `scripts/start.sh` generates one and hands it to both processes.
 */
const live = createLiveConsole({ ingestSecret: process.env.CONSOLE_INGEST_SECRET });

/**
 * Gates the bridge is holding, and the promises waiting on them.
 *
 * The bridge stops speaking the moment a gate opens and resumes only when a
 * decision arrives, so this map is the release. It lives here rather than in
 * the console because the console is a browser page: the decision has to
 * reach the process that holds the caller's stream.
 */
const pendingGates = new Map<string, ResolvedGate>();
const waiting = new Map<string, (d: ApprovalDecision | null) => void>();

/** Settles one held gate. Returns false when nothing was waiting on it, so a
 *  replayed or stale decision cannot look like it worked. */
function decideGate(id: string, decision: ApprovalDecision | null): boolean {
  const settle = waiting.get(id);
  if (!settle) return false;
  waiting.delete(id);
  pendingGates.delete(id);
  settle(decision);
  return true;
}

const bridge = createBridge({
  forge: new TrueForgeClient({ baseUrl: TRUEFORGE_BASE_URL }),
  agentName: AGENT_NAME,
  onApprovalRequired: (gate, _callerId) => {
    console.log(`[gate] approval required: ${gate.tool} ${gate.tool_call_id}`);
    pendingGates.set(gate.tool_call_id, gate);
    live.emit({
      type: 'gate',
      id: gate.tool_call_id,
      tool: gate.tool,
      status: 'opened',
      ...(gate.utterance === undefined ? {} : { wanted: gate.utterance }),
      ...(gate.claim_id === undefined ? {} : { claim_id: gate.claim_id }),
      ...(gate.authorised_amounts === undefined
        ? {}
        : { authorised_amounts: gate.authorised_amounts }),
    });
  },
  awaitApproval: (gate, callerId, signal) =>
    new Promise<ApprovalDecision | null>((settle) => {
      // Held until a human posts to /gate/decide. There is no timer here on
      // purpose: an operator who never decides leaves the caller hearing
      // nothing, which is the outcome this product exists to guarantee.
      waiting.set(gate.tool_call_id, settle);

      // A hangup is not a decision, so this settles null, the same as an
      // operator who never answered: nothing more is spoken. What it does
      // change is that the waiter stops existing and the console stops
      // showing a gate for a call that ended. Without it the promise is
      // never settled at all and the entry never leaves the map.
      if (!signal) return;
      const gone = () => {
        if (!waiting.has(gate.tool_call_id)) return;
        console.log(`[gate] caller gone, dropping held gate ${gate.tool_call_id}`);
        decideGate(gate.tool_call_id, null);
        // The call ending is the truthful event here, not a new gate status:
        // the gate was neither approved nor sent back, there is simply no
        // longer a caller to say anything to.
        // The live console stamps `t` off its own call clock, which is the
        // only one that knows when this call was answered.
        live.emit({ type: 'call', status: 'ended', caller: callerId });
      };
      if (signal.aborted) gone();
      else signal.addEventListener('abort', gone, { once: true });
    }),
  onConsoleEvent: (event) => { live.broadcast(event); },
});

/**
 * Wraps a turn so the console learns two things only this process knows.
 *
 * Hold is the dead air between a caller finishing a sentence and hearing the
 * first word back. That is the real thing an operator watches, and it is
 * exactly this span, so it is measured here rather than guessed at from tool
 * activity.
 *
 * The text is buffered and read at the end of the turn for the numbers in it.
 * The tool process reports what it computed, but it has no idea which of
 * those figures reached the caller's ear, and "numbers spoken" has to mean
 * spoken. A figure that matches one a tool reported is tagged with that
 * tool's provenance; a money figure that matches nothing is reported with no
 * provenance at all, which the console renders red. That is the failure this
 * project exists to make visible, so it is never given a default.
 */
async function* observedTurn(userText: string, callerId: string) {
  live.holdStarted();
  try {
    for await (const delta of bridge.runTurn(userText, callerId)) {
      if (delta.text) {
        live.holdStopped();
        live.noteSpokenText(delta.text);
      }
      yield delta;
    }
  } finally {
    live.holdStopped();
    live.endSpokenTurn();
  }
}

const chat = createChatEndpoint({ runTurn: observedTurn });

/**
 * One decision on one held gate, from a request body.
 *
 * Only the exact strings "allow" and "deny" settle a gate. Anything else, a
 * missing status included, is not a decision and releases nothing: there is
 * no path here from an unparseable body to a caller hearing a binding
 * sentence.
 */
function decideFromBody(raw: string): { status: number; body: unknown } {
  let body: { id?: unknown; status?: unknown; reason?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: 'body was not valid JSON' } };
  }
  const allowed = body.status === 'allow';
  const denied = body.status === 'deny';
  if (typeof body.id !== 'string' || (!allowed && !denied)) {
    return { status: 400, body: { error: 'expected {id, status: "allow" | "deny", reason?}' } };
  }
  const decision: ApprovalDecision = allowed
    ? { status: 'allow' }
    : {
        status: 'deny',
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      };
  const settled = decideGate(body.id, decision);
  return settled
    ? { status: 200, body: { ok: true } }
    : { status: 404, body: { error: 'no gate is waiting on that id' } };
}

/** Constant-time compare so a wrong token cannot be found byte by byte. */
function secretMatches(header: string | undefined): boolean {
  const presented = header?.replace(/^Bearer /i, '') ?? '';
  const expected = SHARED_SECRET as string;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, and the length itself is not
  // worth hiding here, so it is checked first.
  return a.length === b.length && timingSafeEqual(a, b);
}

const handle = createRouter({
  chat,
  secretMatches,
  consoleDir: CONSOLE_DIR,
  agentName: AGENT_NAME,
  origin: `http://localhost:${PORT}`,
  sse: {
    attach: (sink, lastEventId) => { live.attach(sink, lastEventId); },
    detach: (sink) => { live.detach(sink); },
  },
  gate: {
    pending: () => [...pendingGates.values()],
    decide: decideFromBody,
  },
  ingest: (authorization, body) => live.ingest(authorization, body),
});

const server = createServer(
  createNodeHandler({
    handle,
    maxBodyBytes: MAX_BODY_BYTES,
    onRequest: (method, url) => { console.log(`${method} ${url}`); },
  }),
);

server.listen(PORT, () => {
  console.log(`hold-the-line telephony on http://localhost:${PORT}`);
  console.log(`  harness: ${TRUEFORGE_BASE_URL}  agent: ${AGENT_NAME}`);
});

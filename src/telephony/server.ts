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

import { forgetAll } from '../session/store.ts';
import { TrueForgeClient } from '../trueforge/client.ts';
import type { ApprovalDecision, ResolvedGate } from '../trueforge/types.ts';
import { createChatEndpoint } from './chat-endpoint.ts';
import { createBridge } from './harness-bridge.ts';
import { createLiveConsole, readTelnyxStatus } from './live-console.ts';
import { createNodeHandler, createRouter, redactQuery } from './router.ts';

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
  // The link on the sandbox panel opens in the OPERATOR's browser, so it has
  // to be the host TrueForge is actually served from. Without this the bridge
  // fell back to localhost independently of the API client, and a remote or
  // proxied harness sent every operator to a page on their own machine.
  harnessUrl: TRUEFORGE_BASE_URL,
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
  onConsoleEvent: (event) => {
    // The bridge reports the call once its harness session exists. By then
    // the console has been showing it since the first request landed, so this
    // goes through the idempotent path rather than straight to `broadcast`: a
    // second raw `call started` empties the replay buffer and re-anchors the
    // call clock in the middle of a live call.
    if (event.type === 'call' && event.status === 'started') live.callStarted(event.caller);
    else live.broadcast(event);
  },
});

/**
 * The backstop end-of-call.
 *
 * The honest end-of-call signal on this path is the caller's socket going
 * away mid-turn, and that only exists while a turn is open. Telnyx holds one
 * request per turn and nothing in between, so a caller who says goodbye and
 * hangs up in the silence after the agent finished aborts nothing: the
 * console showed ON CALL for a dead line until the next call. The Telnyx
 * status callback is the real fix and fires in about a second; this is here
 * for the case where it does not fire at all.
 *
 * Long on purpose. A caller reading their paperwork is not a caller who
 * hung up, and ending the call on screen under someone still on the line is
 * worse than ending it late.
 */
const IDLE_END_MS = 45_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function disarmIdleEnd(): void {
  if (idleTimer === null) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function armIdleEnd(callerId: string): void {
  disarmIdleEnd();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    console.log(`[call] no turn from ${callerId} in ${IDLE_END_MS}ms, treating the call as over`);
    live.callEnded(callerId);
  }, IDLE_END_MS);
  // Nothing should be kept alive waiting to declare a call over.
  idleTimer.unref?.();
}

/**
 * Wraps a turn so the console learns three things only this process knows.
 *
 * The transcript, first. The caller's utterance is the user message on this
 * request and it arrives whole. The agent's half is the text already on its
 * way out to Telnyx, so it is what the caller hears: the speech shaper has
 * run, and a message the approval gate withheld never gets here to be
 * reported as spoken.
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
 *
 * The caller id goes with both, so a second caller ringing in while this call
 * is on screen cannot fold their hold time or their figures into it.
 */
async function* observedTurn(userText: string, callerId: string, signal?: AbortSignal) {
  disarmIdleEnd();
  // Before anything is awaited. This process knows a call is happening the
  // moment a turn arrives, and the bridge does not know it until a harness
  // session exists; putting the console's anchor behind that round trip was
  // what left the screen idle, and the caller's own words queued, through
  // the one part of the call an operator is watching hardest.
  live.callStarted(callerId, callerId);
  live.callerSaid(userText, callerId);
  live.holdStarted(callerId);
  try {
    // The signal goes through. It was being dropped here, and dropping it took
    // two things down with it: the harness stream was never aborted when a
    // caller hung up, and `awaitApproval` in the gate wiring above is handed
    // `undefined` and returns before installing its abort handler, so a held
    // gate never released and `call ended` was never emitted at all. The turn
    // then sat open forever, which is why an operator watched a hold clock run
    // on a call nobody was on.
    for await (const delta of bridge.runTurn(userText, callerId, signal)) {
      if (delta.text) {
        live.holdStopped(callerId);
        live.noteSpokenText(delta.text, callerId);
      }
      yield delta;
    }
  } finally {
    live.holdStopped(callerId);
    live.endSpokenTurn(callerId);
    // The turn is over, which is not the call being over. Start counting.
    if (live.onCall()) armIdleEnd(callerId);
  }
}

const chat = createChatEndpoint({
  runTurn: observedTurn,
  // The caller's socket going away is the only honest end of call on this
  // path. See the note on `onCallerGone`.
  onCallerGone: (callerId) => {
    console.log(`[call] ${callerId} is gone`);
    disarmIdleEnd();
    live.callEnded(callerId);
    // The physical call is over, so the fast-path session is not live any
    // more. The disk checkpoint still carries the conversation, so the same
    // number ringing back inside the resume window continues where it left
    // off; what changes is that the bridge now reports that resume, which is
    // what reopens the call on screen. Without this the console stayed in
    // "call over" for the whole of the next call. Found by Qodo.
    bridge.sessions.delete(callerId);
  },
});

/**
 * One decision on one held gate, from a request body.
 *
 * Only the exact strings "allow" and "deny" settle a gate. Anything else, a
 * missing status included, is not a decision and releases nothing: there is
 * no path here from an unparseable body to a caller hearing a binding
 * sentence.
 */
const MCP_BASE_URL = process.env.MCP_BASE_URL ?? 'http://localhost:8792';
const GATE_ADMIN_SECRET = process.env.GATE_ADMIN_SECRET;

/**
 * Records an operator's approved wording with the tool process, before the
 * allow goes to TrueForge.
 *
 * This is the step that was missing, and without it the approval did
 * nothing a caller could hear. `offer.state_settlement` never returns the
 * model's own argument: it returns the text an operator put on file, and
 * `takeApprovedText` in src/mcp/gated.ts throws rather than falling back
 * when there is none. So an allow with nothing recorded reached the tool,
 * the tool threw, and the agent narrated its own failure at the claimant
 * instead of reading out the sentence a human had just authorised.
 *
 * The wording recorded is the draft the operator saw and approved. There is
 * no editing path on the wire yet, so approving means approving that
 * sentence, which is exactly what the console showed them.
 *
 * Failing here fails the approval closed. Returning false leaves the gate
 * held rather than sending an allow the tool cannot honour, because a
 * caller hearing nothing is recoverable and a caller hearing a sentence
 * nobody stands behind is not.
 */
const GATE_RECORD_TIMEOUT_MS = 5_000;

/**
 * Recordings run one at a time.
 *
 * `/gate/pending` then `/gate/approve` is two requests against one slot in
 * the tool process, so two approvals landing together can interleave and
 * one operator's wording ends up filed under the other's draft. Serialising
 * costs nothing at one gate a call and removes the interleave entirely.
 * The slot itself is a documented scope limit in src/mcp/gated.ts; this
 * stops this side making it worse. Found by Qodo.
 */
let recording: Promise<unknown> = Promise.resolve();

async function recordApprovedWording(gate: ResolvedGate): Promise<boolean> {
  const utterance = gate.utterance;
  if (gate.tool !== 'offer.state_settlement') return true;
  if (!utterance || !gate.claim_id) {
    console.error(
      `[gate] cannot record an approval for ${gate.tool_call_id}: no draft or claim on the gate`,
    );
    return false;
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (GATE_ADMIN_SECRET) headers['authorization'] = `Bearer ${GATE_ADMIN_SECRET}`;

  const run = async (): Promise<boolean> => {
    // A deadline on both requests. Without one, a tool process that accepts
    // the connection and then stalls leaves the operator's click pending
    // forever and the gate never settles either way. Found by Qodo.
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${MCP_BASE_URL}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GATE_RECORD_TIMEOUT_MS),
      });
    try {
      const pending = await post('/gate/pending', {
        claim_id: gate.claim_id,
        wanted: utterance,
        authorised_amounts: gate.authorised_amounts ?? [],
      });
      if (!pending.ok) {
        console.error(`[gate] /gate/pending refused the draft: ${pending.status}`);
        return false;
      }
      const approve = await post('/gate/approve', { text: utterance });
      if (!approve.ok) {
        console.error(`[gate] /gate/approve refused the wording: ${approve.status}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[gate] could not record an approval with the tool process:', err);
      return false;
    }
  };

  const mine = recording.then(run, run);
  // The chain must survive a rejection, or one failure wedges every later
  // approval behind it.
  recording = mine.catch(() => undefined);
  return mine;
}

/**
 * Tells the tool process the operator has reset, so it drops the pending
 * draft and the amounts a previous offer pre-authorised.
 *
 * Queued behind any approval already recording, for the same reason those
 * are serialised: the two touch one slot in that process, and a reset
 * landing between a `/gate/pending` and its `/gate/approve` would leave the
 * approve with no draft to attach to.
 *
 * A failure here is logged and swallowed. The tool process being unreachable
 * must not stop the console clearing, and the gate itself stays fail-closed
 * either way: `takeApprovedText` throws when nothing is on file rather than
 * speaking the model's own words.
 */
function resetGateState(): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (GATE_ADMIN_SECRET) headers['authorization'] = `Bearer ${GATE_ADMIN_SECRET}`;

  const run = async (): Promise<void> => {
    try {
      const res = await fetch(`${MCP_BASE_URL}/gate/reset`, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(GATE_RECORD_TIMEOUT_MS),
      });
      if (!res.ok) console.warn(`[gate] /gate/reset refused: ${res.status}`);
    } catch (err) {
      console.warn('[gate] could not reset the tool process:', err);
    }
  };

  const mine = recording.then(run, run);
  recording = mine.catch(() => undefined);
  return mine;
}

async function decideFromBody(raw: string): Promise<{ status: number; body: unknown }> {
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
  // Read before deciding: decideGate drops the gate, and the console needs
  // the tool name to render the outcome against the draft it showed.
  const held = pendingGates.get(body.id);
  if (!held) return { status: 404, body: { error: 'no gate is waiting on that id' } };

  // The wording goes on file BEFORE the allow is released. Released first,
  // the resume can reach the tool before the text does, and the tool throws
  // on a gate a human had just approved.
  if (allowed && !(await recordApprovedWording(held))) {
    return {
      status: 502,
      body: { error: 'could not record the approved wording with the tool process' },
    };
  }

  const settled = decideGate(body.id, decision);
  if (!settled) return { status: 404, body: { error: 'no gate is waiting on that id' } };

  // Broadcast rather than let the clicking console render its own outcome.
  // More than one console can be watching, and a console that connects after
  // the click replays this frame out of the buffer, so the decision has to
  // travel the same way every other event does.
  live.emit(
    decision.status === 'allow'
      ? {
          type: 'gate',
          id: body.id,
          tool: held?.tool ?? 'unknown',
          status: 'approved',
          ...(held?.utterance === undefined ? {} : { said: held.utterance }),
        }
      : {
          type: 'gate',
          id: body.id,
          tool: held?.tool ?? 'unknown',
          status: 'sent_back',
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        },
  );
  return { status: 200, body: { ok: true } };
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
  resetConsole: () => {
    disarmIdleEnd();
    live.reset();
    // Clearing the screen is the visible third of a reset. The other two
    // are the bridge's in-memory session per caller and the checkpoint on
    // disk, and either one left standing hands the next call the previous
    // conversation: `sessionFor` checks memory first, then the disk within
    // the ten minute resume window, and only then opens a new session.
    bridge.forgetAll();
    void forgetAll().catch((err: unknown) => {
      console.warn('[console] reset could not clear the checkpoints on disk:', err);
    });
    void resetGateState();
    console.log('[console] reset, the line is back to empty');
  },
  telnyxStatus: (body) => {
    const ev = readTelnyxStatus(body);
    console.log(`[telnyx] call status ${ev.status || '(none)'}`);
    if (ev.kind === 'started') {
      // No caller id. The id every turn is keyed on comes out of Telnyx's
      // request body and is not a phone number, so this opens the call with
      // the number on the header and no owner, and the first turn adopts it.
      live.callStarted(undefined, ev.caller);
    } else if (ev.kind === 'ended') {
      disarmIdleEnd();
      // Only for a call that is actually on screen. An end with no call
      // showing is held as a pending end and applied to whatever starts
      // next, which was safe while the only source was a turn aborting
      // mid-session and is not safe now: a leg that never connected, or a
      // hangup for a call this process was restarted out of, would end the
      // next caller's call the moment it opened.
      if (live.onCall()) live.callEnded();
    }
    // The dynamic-variables webhook is the one caller on this route that
    // reads our answer, and it is holding the greeting until it arrives. It
    // gets the shape it asked for. This assistant templates no `{{variables}}`
    // so the object is empty, but an empty one is answered rather than a
    // wrong one: Telnyx logs a mismatched body as a webhook error, which is
    // noise on the one surface anybody would look at to debug a dead screen.
    if (ev.wantsVariables) {
      return { status: 200, body: { dynamic_variables: {} } };
    }
    return { status: 200, body: { ok: true } };
  },
});

const server = createServer(
  createNodeHandler({
    handle,
    maxBodyBytes: MAX_BODY_BYTES,
    onRequest: (method, url) => { console.log(`${method} ${redactQuery(url)}`); },
  }),
);

server.listen(PORT, () => {
  console.log(`hold-the-line telephony on http://localhost:${PORT}`);
  console.log(`  harness: ${TRUEFORGE_BASE_URL}  agent: ${AGENT_NAME}`);
});

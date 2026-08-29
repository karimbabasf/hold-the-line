/**
 * The console's live end: SSE clients, a per-call replay buffer, the ingest
 * route the tool process reports through, and the provenance ledger.
 *
 * Before this, `broadcast()` was reachable from three places and none of them
 * produced the four event types that fill the console's panes. A local `/sse`
 * gave 0 bytes across a whole live call. The panes only ever had anything in
 * them because `console.ts` replays a recorded fixture by default.
 *
 * Four things live here, and they are here together because each one is a few
 * lines and they all key off the same call clock:
 *
 *   - The client set and the frame encoder.
 *   - A bounded per-call ring buffer, replayed to a client that connects
 *     mid-call. `sseClients.add(res)` had no catch-up at all, so opening the
 *     console during a call showed a blank screen until the next event.
 *   - `ingest()`, which takes a batch of events from another local process.
 *     Authenticated, because the telephony listener is on a public tunnel:
 *     an open ingest route would let anyone who found the tunnel write
 *     whatever they liked onto an operator's screen.
 *   - The provenance ledger, which is what makes "numbers spoken" a true
 *     count rather than a hopeful one. See `spoken-numbers.ts`.
 *
 * No port is bound here. `server.ts` owns the socket; this owns the state.
 */

import { timingSafeEqual } from 'node:crypto';

import {
  encodeSSE,
  isReportBatch,
  type ConsoleEvent,
  type ConsoleEventBody,
  type NumberEvent,
} from '../console/events.ts';
import { extractSpokenNumbers } from './spoken-numbers.ts';

/** The whole of what this needs from an HTTP response. */
export interface SseSink {
  write(chunk: string): void;
}

export interface LiveConsoleOptions {
  /** Bearer token `POST /ingest` must present. Without one the route fails
   *  closed: an unauthenticated ingest on a publicly tunnelled listener is
   *  a worse default than a console with no live events. */
  ingestSecret?: string | undefined;
  /** Frames kept for a client that connects mid-call. A two-minute call
   *  emits a few dozen; 400 covers a long one without letting a call that
   *  runs for an hour grow this without limit. */
  bufferLimit?: number;
  now?: () => number;
}

interface Frame {
  id: number;
  text: string;
}

/** What a tool reported about one figure, kept so it can be attached to the
 *  figure again if and when the agent actually says it out loud. */
interface Provenance {
  label: string;
  from?: 'computed' | 'record' | undefined;
  run_id?: string | undefined;
  source?: string | undefined;
  unit?: NumberEvent['unit'];
}

const DEFAULT_BUFFER_LIMIT = 400;

/** Units a bare spoken number is looked up under, most likely first. A
 *  figure the agent framed as money is only ever looked up as money. */
const UNIT_ORDER = ['days', 'percent', 'usd'] as const;

const cents = (dollars: number): number => Math.round(dollars * 100);

/**
 * A ledger key is the unit as well as the number.
 *
 * Keying on the number alone put a 75 percent total-loss threshold and a
 * $75.00 daily storage rate in the same slot, so whichever lane landed last
 * decided what a spoken "$75.00" claimed as its source. A figure that
 * inherits the wrong provenance is worse than one with none: it is an
 * overclaim, which is the exact failure the counters exist to catch. Found
 * by Qodo.
 */
const ledgerKey = (unit: string | undefined, value: number): string =>
  `${unit ?? 'usd'}:${cents(value)}`;

function tokenMatches(header: string | undefined, secret: string): boolean {
  const presented = header?.replace(/^Bearer /i, '') ?? '';
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  // timingSafeEqual throws on a length mismatch, and the length of a token
  // is not worth hiding, so it is checked first.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createLiveConsole(options: LiveConsoleOptions = {}) {
  const now = options.now ?? Date.now;
  const bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
  const ingestSecret = options.ingestSecret;

  const clients = new Set<SseSink>();
  const buffer: Frame[] = [];
  /**
   * The frames a client cannot render the screen without, kept past the point
   * the ring buffer drops them. Without the call frame a late client has no
   * claim id and no header; without the latest hold frame its hold clock
   * never starts; and on a call that came back after a restart there is no
   * call frame at all, only the session that resumed. Everything else is safe
   * to lose to the bound.
   */
  const pinned = new Map<'call' | 'hold' | 'session', Frame>();

  const ledger = new Map<string, Provenance>();
  const alreadySpoken = new Set<string>();
  let turnText = '';

  let seq = 0;
  /**
   * Null until the first `call started`. Every `t` before that is 0 rather
   * than milliseconds since this process booted: a turn opens the hold before
   * the bridge reports the call, and a hold that starts at t=20396 and stops
   * at t=1200 gives the console a negative hold clock.
   */
  let callStart: number | null = null;
  /**
   * Whose call is on screen.
   *
   * The console shows one call at a time, which is the product (spec section
   * 1: one adjuster, one call at a time), and this is what keeps that from
   * failing silently. A second caller's turn running at the same time would
   * otherwise fold its hold and its spoken figures into the first caller's
   * counters, which is an overclaim rather than a missing feature. See the
   * scope note at the bottom of this file. Found by Qodo.
   */
  let currentCaller: string | null = null;
  const warnedCallers = new Set<string>();
  let onHold = false;
  let pendingHold = false;
  let warnedUnconfigured = false;

  /** True when this turn belongs to the call the console is showing. */
  function ownsCall(callerId?: string): boolean {
    if (callerId === undefined || currentCaller === null) return true;
    if (callerId === currentCaller) return true;
    if (!warnedCallers.has(callerId)) {
      warnedCallers.add(callerId);
      console.warn(
        `console is showing the call from ${currentCaller}; the turn from ${callerId} is not ` +
          'being rendered. This console follows one call at a time.',
      );
    }
    return false;
  }

  function push(frame: Frame, event: ConsoleEvent): void {
    buffer.push(frame);
    // Only a call STARTING is pinned. A hangup emits `call ended`, and
    // pinning that would replace the frame a late client renders its header
    // from, leaving it looking at a call it was never told began.
    if (event.type === 'call' && event.status === 'started') pinned.set('call', frame);
    else if (event.type === 'hold') pinned.set('hold', frame);
    else if (event.type === 'session') pinned.set('session', frame);
    while (buffer.length > bufferLimit) buffer.shift();
  }

  function broadcast(event: ConsoleEvent, at?: number): void {
    // One clock. Whatever `t` an event arrives with is replaced by this
    // process's own reading, because it is the only one that knows when this
    // call was answered and it has to stay consistent across the two
    // processes reporting into it.
    if (event.type === 'call' && event.status === 'started') {
      callStart = at ?? now();
      currentCaller = event.caller ?? null;
      warnedCallers.clear();
      buffer.length = 0;
      pinned.clear();
      ledger.clear();
      alreadySpoken.clear();
      turnText = '';
      onHold = false;
    } else if (callStart === null && event.type === 'session' && event.status === 'resumed') {
      // A call that came back after this process restarted never reports a
      // `call started`: the bridge finds a checkpoint and reports a resume.
      // Without anchoring here, every event on that call is stamped t: 0 and
      // the console re-anchors its clocks to zero over and over. Found by
      // Qodo.
      callStart = at ?? now();
    }
    const stamped = {
      ...event,
      t: callStart === null ? 0 : Math.max(0, (at ?? now()) - callStart),
    } as ConsoleEvent;

    if (stamped.type === 'number' && !stamped.spoken) {
      ledger.set(ledgerKey(stamped.unit, stamped.value), {
        label: stamped.label,
        from: stamped.from,
        run_id: stamped.run_id,
        source: stamped.source,
        unit: stamped.unit,
      });
    }

    const frame: Frame = { id: seq++, text: encodeSSE(stamped, seq - 1) };
    push(frame, stamped);
    for (const client of clients) client.write(frame.text);

    // A hold that was asked for before the call was reported goes out now,
    // in the order an operator reads: the call, then the caller waiting on it.
    if (pendingHold && callStart !== null) {
      pendingHold = false;
      holdStarted();
    }
  }

  function emit(body: ConsoleEventBody, at?: number): void {
    broadcast({ ...body, t: 0 } as ConsoleEvent, at);
  }

  function attach(sink: SseSink, lastEventId?: string | undefined): void {
    const since = lastEventId !== undefined && lastEventId !== '' ? Number(lastEventId) : NaN;

    if (Number.isFinite(since)) {
      // A reconnect. Only what it missed, and only as far back as the buffer
      // still reaches.
      for (const frame of buffer) {
        if (frame.id > since) sink.write(frame.text);
      }
    } else {
      const headId = buffer[0]?.id ?? Number.POSITIVE_INFINITY;
      const carried = [...pinned.values()].filter((f) => f.id < headId).sort((a, b) => a.id - b.id);
      for (const frame of carried) sink.write(frame.text);
      for (const frame of buffer) sink.write(frame.text);
    }

    clients.add(sink);
  }

  function detach(sink: SseSink): void {
    clients.delete(sink);
  }

  /**
   * Takes one batch of reported events from another local process.
   *
   * The whole batch is validated before any of it is broadcast: a half
   * applied batch would leave a lane pending on screen forever with no way
   * to tell that from a slow tool.
   */
  function ingest(
    authorization: string | undefined,
    body: string,
  ): { status: number; body: unknown } {
    if (!ingestSecret) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        console.warn(
          'CONSOLE_INGEST_SECRET is not set: refusing live console events from the tool ' +
            'process. This listener is on a public tunnel, so an open ingest route would let ' +
            'anyone who found it write onto the operator screen. Set the variable in ' +
            '.env.local, or let scripts/start.sh generate one.',
        );
      }
      return { status: 503, body: { error: 'ingest is not configured' } };
    }
    if (!tokenMatches(authorization, ingestSecret)) {
      return { status: 401, body: { error: 'unauthorized' } };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { status: 400, body: { error: 'body is not JSON' } };
    }
    if (!isReportBatch(parsed)) {
      return { status: 400, body: { error: 'expected {frames: [{at, event}]}' } };
    }

    for (const frame of parsed.frames) emit(frame.event, frame.at);
    return { status: 202, body: { accepted: parsed.frames.length } };
  }

  /** The caller is waiting in silence. Idempotent: a turn that starts while
   *  the line is already quiet does not restart the clock. */
  function holdStarted(callerId?: string): void {
    if (!ownsCall(callerId)) return;
    if (onHold || pendingHold) return;
    if (callStart === null) {
      // The first turn opens the hold before the bridge has reported the
      // call. Held back rather than dropped: the caller really is waiting.
      pendingHold = true;
      return;
    }
    onHold = true;
    emit({ type: 'hold', status: 'started' });
  }

  function holdStopped(callerId?: string): void {
    if (!ownsCall(callerId)) return;
    pendingHold = false;
    if (!onHold) return;
    onHold = false;
    emit({ type: 'hold', status: 'stopped' });
  }

  /** Text on its way to TTS. Buffered rather than scanned per chunk, because
   *  a figure arrives split across deltas ("13,481" then " dollars and 12
   *  cents") and half a number is not a number. */
  function noteSpokenText(text: string, callerId?: string): void {
    if (!ownsCall(callerId)) return;
    turnText += text;
  }

  /** End of the agent's turn: everything it said is now complete text. */
  function endSpokenTurn(callerId?: string): void {
    if (!ownsCall(callerId)) return;
    const text = turnText;
    turnText = '';
    if (text === '') return;

    for (const found of extractSpokenNumbers(text)) {
      // Money spoken as money can only be money. A bare number could be any
      // of the three, so the units it is most likely to be are tried first.
      const key = found.money
        ? ledgerKey('usd', found.value)
        : (UNIT_ORDER.map((unit) => ledgerKey(unit, found.value)).find((k) => ledger.has(k))
          ?? ledgerKey('usd', found.value));
      if (alreadySpoken.has(key)) continue;
      const known = ledger.get(key);
      // A figure with no tool behind it is only reported when the agent
      // framed it as money. Reporting every bare digit would bury the one
      // alarm that matters under claim numbers and dates.
      if (!known && !found.money) continue;
      alreadySpoken.add(key);
      emit({
        type: 'number',
        label: known?.label ?? 'Said on the call, no tool behind it',
        value: found.value,
        ...(known?.from ? { from: known.from } : {}),
        ...(known?.run_id ? { run_id: known.run_id } : {}),
        ...(known?.source ? { source: known.source } : {}),
        unit: known?.unit ?? 'usd',
        spoken: true,
      });
    }
  }

  return {
    broadcast,
    emit,
    attach,
    detach,
    ingest,
    holdStarted,
    holdStopped,
    noteSpokenText,
    endSpokenTurn,
    clientCount: (): number => clients.size,
    bufferedFrames: (): number => buffer.length,
  };
}

/**
 * Known scope limit, flagged rather than hidden.
 *
 * This holds one call: one clock, one buffer, one hold state, one ledger.
 * That matches the product (spec section 1: one adjuster, one call at a
 * time) and the console itself, which has one header, one claim id and one
 * set of counters. `gated.ts` carries the same limit on the draft slot for
 * the same reason.
 *
 * What is enforced: a turn belonging to a caller other than the one on
 * screen contributes no hold time and no spoken figures, and says so in the
 * log once per caller. Without that, a second caller's speech would land on
 * the first caller's provenance counters, which is an overclaim rather than
 * a gap.
 *
 * What is not, and cannot be here: events reported by the MCP tool process
 * carry no caller. TrueForge calls a tool with the tool's arguments and
 * nothing else, so that process genuinely does not know whose call it is
 * working on. Partitioning the console by caller needs a call id on the MCP
 * wire, which is a protocol change beyond this file. Until then, two
 * concurrent callers put both sets of lane and number events on one screen.
 * The most recent `call started` takes the console.
 */

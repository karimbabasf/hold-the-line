/**
 * The operator console's client-side controller.
 *
 * This file only ever runs in a browser: it is never imported by
 * `node --test`, so it is free to use `document`, `window` and
 * `EventSource` without the rest of the project's Node-only `tsconfig.json`
 * `lib` needing to grow. The `/// <reference lib="dom" />` directives below
 * pull in just enough ambient browser typing for this one file to
 * typecheck under `npx tsc -p tsconfig.json --noEmit`.
 *
 * By default this connects live to `/sse`, so the operator sees real call
 * data the moment they open the page. Query parameters switch to the
 * recorded demo or change playback for development:
 *
 *   ?demo             replay `recordedNorthvaneCall()` in real time.
 *   ?speed=20         replay faster than real time (debugging, not demo).
 *   ?until=71000      dispatch every event with t <= 71000 instantly, then
 *                      freeze there. Used to capture screenshots with the
 *                      gate open.
 *   ?live=<url>       connect to a custom emitter URL instead of /sse.
 *
 * Live, the gate buttons post to `/gate/decide` on the telephony process,
 * which is what actually releases a held caller. In replay they resolve the
 * fixture locally, because there is no held caller to release.
 *
 * None of these change the event contract in `events.ts`; they only
 * change how this file schedules dispatch.
 *
 * WHO THIS SCREEN IS FOR
 *
 * A person watching a claim call, not a person debugging one. Everything
 * on the primary view is in the words that person already uses: "Reading
 * the policy", not `policy.lookup`; "Read from the claim file", not
 * `record - state_rules.json:mileage_adjustment_per_mile`. The provenance
 * is still all there, one disclosure away, because the proof is the point
 * of the project. It is just not the loudest thing on the screen any more.
 */

/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import {
  encodeSSE as _encodeSSE,
  isConsoleEvent,
  recordedNorthvaneCall,
  type CallEvent,
  type ConsoleEvent,
  type GateEvent,
  type HoldEvent,
  type LaneEvent,
  type LanesSummaryEvent,
  type NumberEvent,
  type SessionEvent,
  type TranscriptEvent,
} from './events.ts';
import { createGateClient, type GateResult } from './gate-client.ts';
import type { SettleLine } from '../settle/settle.ts';
import {
  formatUsd,
  numbersFromEvents,
  tally,
  tallyUtterances,
  utterancesFromEvents,
} from './counters.ts';

// Referenced so a bundler or reviewer can see `encodeSSE` is part of the
// same contract this file consumes, without console.ts needing to encode
// anything itself in fixture-replay mode.
void _encodeSSE;

// ---------------------------------------------------------------------------
// Small DOM helpers. No framework, so this is the whole of it.

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`console.ts: index.html is missing #${id}`);
  return found as T;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  children?: Array<Node | string>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children ?? []) {
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * How long something took, in a unit that is true at this size.
 *
 * The lanes used to render as `(ms / 1000).toFixed(1)` unconditionally,
 * which prints "0.0s" for everything a local fixture does, because a local
 * fixture answers in single-digit milliseconds. Working software that
 * reports 0.0s reads as broken software. Sub-second work is reported in
 * milliseconds, and the whole point of the fan-out counter, that five
 * things happened at once, survives either way.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatNumberValue(ev: NumberEvent): string {
  if (ev.unit === 'percent') return `${ev.value}%`;
  if (ev.unit === 'days') return `${ev.value} ${ev.value === 1 ? 'day' : 'days'}`;
  return formatUsd(ev.value);
}

/** A provenance tag, said the way a person would say it. The strings behind
 *  it (`run_id`, `source`) stay available in the disclosure below the
 *  statement; they are not what a viewer should be reading first. */
function provenanceWords(from: 'computed' | 'record' | undefined): string {
  if (from === 'computed') return 'Worked out on this call';
  if (from === 'record') return 'Read from the claim file';
  return 'No source. Do not say this figure.';
}

// ---------------------------------------------------------------------------
// The one place that decides what the screen is showing.
//
// The old header could say ON CALL while the panel beside it said "Waiting
// for the call to start", because two different handlers each owned a piece
// of the answer. There is one answer now and one function that applies it,
// so the two cannot disagree.

type Screen = 'idle' | 'live' | 'gate' | 'ended';

let callLive = false;
let callEverStarted = false;
let gateIsOpen = false;

function currentScreen(): Screen {
  if (!callEverStarted) return 'idle';
  if (!callLive) return 'ended';
  return gateIsOpen ? 'gate' : 'live';
}

function applyScreen(): void {
  const screen = currentScreen();
  document.body.dataset['state'] = screen;

  const chip = el('status-chip');
  const chipText: Record<Screen, string> = {
    idle: 'Line ready',
    live: 'On air',
    gate: 'Line halted',
    ended: 'Call ended',
  };
  chip.textContent = chipText[screen];

  // A clock never runs against a line nobody is on. `call-stat` appears with
  // the call and freezes with it; `hold-stat` appears only while a caller is
  // genuinely holding, which is what stopped the old "CALLER ON HOLD 0:02"
  // counting up over an empty screen.
  el('call-stat').hidden = screen === 'idle';
  el('hold-stat').hidden = !(holdRunning && callLive);

  el('doing-now').textContent = describeActivity();
}

// ---------------------------------------------------------------------------
// The call clock and the hold clock.
//
// Both are driven off `virtualNow()`, a call-time clock, rather than raw
// wall time. In real-time replay the two track together. In `?until=`
// fast-forward mode every event up to the cutoff dispatches instantly, so a
// wall clock would show the hold at a few milliseconds; `virtualNow()`
// instead reports the call-time position and keeps ticking forward from
// there in real time once paused, which is what "how long has this caller
// been on hold" should show while a screenshot is being taken.

let playbackEpoch = Date.now();
let playbackOrigin = 0;
let playbackSpeed = 1;
let playbackPaused = false;
let pausedAtCallTime = 0;

function virtualNow(): number {
  if (playbackPaused) return pausedAtCallTime + (Date.now() - playbackEpoch);
  return playbackOrigin + (Date.now() - playbackEpoch) * playbackSpeed;
}

let holdRunning = false;
let holdStartedAtCallTime = 0;
let holdAccumulatedMs = 0;

function onHold(ev: HoldEvent): void {
  if (ev.status === 'started') {
    holdRunning = true;
    holdStartedAtCallTime = ev.t;
  } else {
    if (holdRunning) holdAccumulatedMs += ev.t - holdStartedAtCallTime;
    holdRunning = false;
  }
  applyScreen();
}

function currentHoldMs(): number {
  if (!holdRunning) return holdAccumulatedMs;
  return holdAccumulatedMs + (virtualNow() - holdStartedAtCallTime);
}

/** Set once `call.ended` arrives, so the header clock holds the call's
 *  actual duration instead of counting up forever after the last scheduled
 *  event, which `virtualNow()` has no reason to stop advancing past on its
 *  own. */
let callEndedAtCallTime: number | null = null;

function tickClocks(): void {
  // No call, no clocks. Nothing to count and nothing on screen to count it.
  if (!callEverStarted) return;
  el('call-clock').textContent = formatClock(callEndedAtCallTime ?? virtualNow());
  if (holdRunning && callLive) el('hold-clock').textContent = formatClock(currentHoldMs());
  tickGateHold();
}

// ---------------------------------------------------------------------------
// What the agent is doing, in the words a person watching would use.
//
// The lanes are the raw material. A lane is an MCP tool call with a tool
// name on it; nobody watching a claim call needs to read `policy.lookup` to
// understand that the agent is reading the policy.

const LANE_WORDS: Record<string, string> = {
  'policy.lookup': 'Reading the policy',
  'valuation.comps': 'Pricing the car against recent sales',
  'lienholder.payoff_quote': 'Getting the loan payoff',
  'claims_history.get': 'Checking past claims on this car',
  'state_rules.get': "Checking the state's rules",
};

function laneWords(ev: LaneEvent): string {
  const known = LANE_WORDS[ev.tool];
  if (known) return known;
  // Unknown tool: fall back to the lane's own human label rather than to the
  // tool name, which is the one string this screen must never show.
  return ev.name.charAt(0).toUpperCase() + ev.name.slice(1);
}

interface LaneState {
  ev: LaneEvent;
  row: HTMLLIElement;
}

const lanes = new Map<string, LaneState>();
let settlementKnown = false;
/** Set by the events that describe themselves better than the lane state
 *  can (a redraft, a dropped line), cleared by the next thing that happens. */
let activityOverride: string | null = null;

function describeActivity(): string {
  if (!callEverStarted) return '';
  if (!callLive) return 'The call is finished.';
  if (gateIsOpen) return 'Waiting for your approval';
  if (activityOverride) return activityOverride;
  const pending = [...lanes.values()].some((l) => l.ev.status === 'pending');
  if (pending) return 'Looking up the claim record';
  if (!settlementKnown) return 'Working out the settlement';
  return 'Talking the caller through the numbers';
}

function onLane(ev: LaneEvent): void {
  activityOverride = null;
  let state = lanes.get(ev.tool);
  if (!state) {
    const row = h('li', { class: 'step' });
    el('steps').appendChild(row);
    state = { ev, row };
    lanes.set(ev.tool, state);
  }
  state.ev = ev;
  state.row.className = `step step--${ev.status}`;
  state.row.replaceChildren(
    h('span', { class: 'step-mark' }, [ev.status === 'done' ? '✓' : '●']),
    h('span', {}, [
      laneWords(ev),
      h('span', { class: 'step-took mono' }, [
        ev.status === 'done' ? formatDuration(ev.elapsed_ms ?? 0) : 'running',
      ]),
    ]),
  );
  applyScreen();
}

function onLanesSummary(ev: LanesSummaryEvent): void {
  const count = lanes.size || 5;
  const box = el('together');
  box.hidden = false;
  box.replaceChildren(
    `All ${count} checks ran at the same time. `,
    h('b', {}, [formatDuration(ev.parallel_ms)]),
    ' instead of ',
    h('b', {}, [formatDuration(ev.serial_ms)]),
    ' one after another.',
  );
}

// ---------------------------------------------------------------------------
// The transcript. The centrepiece: it is how a viewer follows the call.
//
// A `final: false` line replaces the previous unfinished line from the same
// speaker, so a sentence fills in where it started rather than stacking up
// half-written copies of itself.

const unfinished = new Map<TranscriptEvent['who'], HTMLElement>();

function onTranscript(ev: TranscriptEvent): void {
  const box = el('transcript');
  const placeholder = box.querySelector('.transcript-empty');
  if (placeholder) placeholder.remove();

  let node = unfinished.get(ev.who);
  if (node) {
    const text = node.querySelector('.line-text');
    if (text) text.textContent = ev.text;
  } else {
    node = h('div', { class: `line line--${ev.who}` }, [
      h('span', { class: 'line-who' }, [ev.who === 'caller' ? 'Caller' : 'Agent']),
      h('div', { class: 'line-text' }, [ev.text]),
    ]);
    box.appendChild(node);
  }
  node.className = `line line--${ev.who}${ev.final ? '' : ' line--partial'}`;
  if (ev.final) unfinished.delete(ev.who);
  else unfinished.set(ev.who, node);

  box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------------------
// The money. One figure, the few numbers under it, and a total that a
// viewer can add up themselves.

interface MoneyLine {
  label: string;
  value: number;
  from?: 'computed' | 'record' | undefined;
  detail?: string | undefined;
}

/** The settlement breakdown, once a gate has carried one. This is the
 *  version that reconciles: its lines sum to the figure above them. */
let statementLines: MoneyLine[] = [];
/** The headline figure. Whatever the agent last worked out as the net. */
let headline: { label: string; value: number } | null = null;
/** Everything spoken in dollars before a breakdown exists, so the panel is
 *  not empty for the first half of the call. */
const dollarsSoFar: MoneyLine[] = [];

function statementRow(line: MoneyLine): HTMLLIElement {
  const unsourced = line.from === undefined;
  return h('li', { class: `stmt-row${unsourced ? ' stmt-row--unsourced' : ''}` }, [
    h('span', { class: 'stmt-label' }, [line.label]),
    h('span', { class: 'stmt-value mono' }, [formatUsd(line.value)]),
  ]);
}

function renderMoney(): void {
  const money = el('money');
  const lines = statementLines.length > 0 ? statementLines : dollarsSoFar;

  if (headline === null && lines.length === 0) {
    money.replaceChildren(
      h('div', { class: 'money-figure money-figure--none' }, ['Not worked out yet']),
      h('div', { class: 'money-caption' }, ['The agent is still gathering the facts.']),
    );
    return;
  }

  const children: Node[] = [];
  if (headline) {
    children.push(h('div', { class: 'money-figure mono' }, [formatUsd(headline.value)]));
    children.push(h('div', { class: 'money-caption' }, [headline.label]));
  } else {
    children.push(h('div', { class: 'money-figure money-figure--none' }, ['Still adding up']));
    children.push(h('div', { class: 'money-caption' }, ['These are the numbers so far.']));
  }

  const rows = lines.map(statementRow);
  // A total rule is only honest under the breakdown, whose lines actually
  // sum to the figure. The running list above it does not, so it does not
  // get one.
  if (statementLines.length > 0 && headline) {
    rows.push(
      h('li', { class: 'stmt-row stmt-row--total' }, [
        h('span', { class: 'stmt-label' }, ['What we pay']),
        h('span', { class: 'stmt-value mono' }, [formatUsd(headline.value)]),
      ]),
    );
  }
  children.push(h('ul', { class: 'statement' }, rows));

  // Provenance, kept and demoted. A viewer who wants the proof opens this;
  // a viewer watching the call is not made to read it.
  children.push(
    h('details', { class: 'provenance' }, [
      h('summary', {}, ['Where each number came from']),
      h(
        'ul',
        { class: 'prov-list' },
        lines.map((line) =>
          h('li', { class: 'prov-row' }, [
            h('div', { class: 'prov-label' }, [line.label]),
            h('div', { class: 'prov-detail' }, [
              provenanceWords(line.from) + (line.detail ? `. ${line.detail}` : '.'),
            ]),
          ]),
        ),
      ),
    ]),
  );

  money.replaceChildren(...children);
}

function onNumber(ev: NumberEvent): void {
  activityOverride = null;
  if (/^net settlement/i.test(ev.label)) {
    headline = { label: ev.label, value: ev.value };
    settlementKnown = true;
  } else if (ev.unit === 'usd') {
    dollarsSoFar.push({
      label: ev.label,
      value: ev.value,
      from: ev.from,
      detail: ev.from === 'record' ? ev.source : ev.run_id,
    });
  }
  renderMoney();
  applyScreen();
}

function adoptBreakdown(breakdown: SettleLine[]): void {
  if (breakdown.length === 0) return;
  statementLines = breakdown.map((line) => ({
    label: line.label,
    value: line.value,
    from: line.from,
    detail: line.detail,
  }));
  renderMoney();
}

// ---------------------------------------------------------------------------
// Releasing a gate.
//
// Two transports, and the difference between them is whether there is a
// caller on the line. Live, a click posts to `/gate/decide` and a real
// person stops hearing silence; the outcome comes back on the SSE stream
// like every other event, so every console watching sees it and one that
// connects afterwards replays it. In fixture replay there is nothing to
// release, so the click resolves the recording locally.
//
// Neither transport has a timer. Nothing here approves anything on its own.

interface GateTransport {
  /** True when a decision reaches a process holding a real caller. */
  live: boolean;
  approve(gate: GateState, said: string): Promise<GateResult>;
  sendBack(gate: GateState, reason: string): Promise<GateResult>;
}

/** Where the operator token lives for this tab.
 *
 *  Not in the page. This listener is on a public tunnel, so anything served
 *  from it is served to whoever finds the tunnel, and the token that decides
 *  what a caller hears cannot travel that way. The operator pastes it once. */
const TOKEN_KEY = 'hold-the-line.operator-token';

function readToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // A browser with site data blocked keeps the token in memory for this
    // page load only, which is enough to work a call.
    memoryToken = token;
  }
}

let memoryToken: string | null = null;

const gateClient = createGateClient({ token: () => readToken() ?? memoryToken });

const liveTransport: GateTransport = {
  live: true,
  approve: (gate) => gateClient.approve(gate.id),
  sendBack: (gate, reason) => gateClient.sendBack(gate.id, reason),
};

const replayTransport: GateTransport = {
  live: false,
  approve(gate, said) {
    resolveGateLocally(gate, said);
    return Promise.resolve({ ok: true });
  },
  sendBack(gate, reason) {
    sendBackLocally(gate, reason);
    return Promise.resolve({ ok: true });
  },
};

let gateTransport: GateTransport = replayTransport;

// ---------------------------------------------------------------------------
// How long the caller has been held by THIS gate.
//
// The header's hold clock counts every kind of dead air. This one counts
// only the part an operator is causing by not deciding, which is the number
// that should make them uncomfortable.

let gateOpenedAtCallTime: number | null = null;
let gateHeldEl: HTMLElement | null = null;

function tickGateHold(): void {
  if (!gateHeldEl || gateOpenedAtCallTime === null) return;
  const heldMs = Math.max(0, virtualNow() - gateOpenedAtCallTime);
  gateHeldEl.textContent = `The caller has been waiting ${formatClock(heldMs)} on this.`;
}

// ---------------------------------------------------------------------------
// Gate pane.

interface DiffPart {
  text: string;
  kind: 'same' | 'removed' | 'added';
}

function req(x: string | undefined): string {
  if (x === undefined) throw new Error('wordDiff: index out of range');
  return x;
}

/**
 * A word-level diff by common prefix and common suffix.
 *
 * Not a full LCS: it collapses everything between the last matching prefix
 * word and the first matching suffix word into one removed/added span. For
 * the edit this console exists to make visible, striking a word or a clause
 * out of a settlement sentence, that is exactly the right shape and it is a
 * few lines instead of a DP table.
 */
function wordDiff(before: string, after: string): DiffPart[] {
  const a = before.split(/(\s+)/).filter((s) => s !== '');
  const b = after.split(/(\s+)/).filter((s) => s !== '');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const out: DiffPart[] = [];
  for (let i = 0; i < start; i++) out.push({ text: req(a[i]), kind: 'same' });
  for (let i = start; i <= endA; i++) out.push({ text: req(a[i]), kind: 'removed' });
  for (let i = start; i <= endB; i++) out.push({ text: req(b[i]), kind: 'added' });
  for (let i = endA + 1; i < a.length; i++) out.push({ text: req(a[i]), kind: 'same' });
  return out;
}

function renderWordDiff(before: string, after: string): HTMLElement[] {
  return wordDiff(before, after).map((part) => {
    if (part.kind === 'removed') return h('del', { class: 'diff-removed' }, [part.text]);
    if (part.kind === 'added') return h('ins', { class: 'diff-added' }, [part.text]);
    return h('span', { class: 'diff-same' }, [part.text]);
  });
}

interface GateState {
  id: string;
  tool: string;
  wanted: string;
  breakdown: SettleLine[];
  sources: string[];
  authorisedAmounts: number[];
}

let currentGate: GateState | null = null;
/** Dismisses the resolved-gate card after it has been read. Cleared on any
 *  new gate so a fast redraft cannot be wiped by the previous one's timer. */
let gateDismissTimer: ReturnType<typeof setTimeout> | null = null;

function showGateLayer(): void {
  if (gateDismissTimer !== null) {
    clearTimeout(gateDismissTimer);
    gateDismissTimer = null;
  }
  el('gate-layer').hidden = false;
}

function hideGateLayerAfter(ms: number): void {
  if (gateDismissTimer !== null) clearTimeout(gateDismissTimer);
  gateDismissTimer = setTimeout(() => {
    el('gate-layer').hidden = true;
    gateDismissTimer = null;
  }, ms);
}

function renderGateOpen(gate: GateState): void {
  showGateLayer();
  const card = el('gate');
  card.className = 'gate';
  card.replaceChildren();

  card.appendChild(h('div', { class: 'gate-eyebrow' }, ['Needs you now']));
  card.appendChild(
    h('h2', { class: 'gate-h', id: 'gate-heading' }, ['The agent wants to make a binding offer']),
  );
  // TrueForge answers any further caller utterance with 422 while a gate is
  // open. This is not a hold in the ordinary sense, the line is stopped, so
  // the console says that plainly rather than leaving it implied.
  card.appendChild(
    h('p', { class: 'gate-sub' }, [
      'Nothing is said to the caller until you decide. The line is silent right now.',
    ]),
  );

  card.appendChild(h('label', { class: 'field-label', for: 'gate-say' }, ['What the agent wants to say']));
  const textarea = h('textarea', { class: 'gate-say', id: 'gate-say', rows: '3' });
  textarea.value = gate.wanted;
  card.appendChild(textarea);

  // The change block stays out of the way until there is a change to show.
  // A viewer watching a demo should not be reading "no change from the
  // draft" on a draft nobody has touched.
  const changeWrap = h('div', {}, [
    h('span', { class: 'field-label' }, ['What you changed']),
    h('div', { class: 'gate-change' }),
  ]);
  changeWrap.hidden = true;
  card.appendChild(changeWrap);
  const changeBox = changeWrap.querySelector('.gate-change') as HTMLElement;

  const left = h('div', {});
  left.appendChild(h('label', { class: 'field-label', for: 'gate-reason' }, ['If you send it back, say why']));
  const reasonBox = h('textarea', {
    class: 'gate-reason',
    id: 'gate-reason',
    rows: '3',
    placeholder: 'The agent reads this and writes the offer again.',
  });
  left.appendChild(reasonBox);

  const btnApprove = h('button', { class: 'btn btn--approve' }, ['Approve and say it']);
  const btnApproveEdits = h('button', { class: 'btn btn--approve-edits is-inactive' }, ['Approve my wording']);
  btnApproveEdits.disabled = true;
  const btnSendBack = h('button', { class: 'btn btn--send-back' }, ['Send back']);
  gateHeldEl = h('span', { class: 'gate-waiting mono' }, ['The caller has been waiting 0:00 on this.']);
  left.appendChild(
    h('div', { class: 'gate-buttons' }, [btnApprove, btnApproveEdits, btnSendBack, gateHeldEl]),
  );

  const status = h('div', { class: 'gate-status' });
  left.appendChild(status);

  if (gateTransport.live && (readToken() ?? memoryToken) === null) {
    renderTokenRow(left, () => {
      say('Token held for this tab. The buttons will reach the server now.');
    });
  }

  const right = h('div', {});
  right.appendChild(h('span', { class: 'field-label' }, ['How the figure adds up']));
  const rows = gate.breakdown.map((line) =>
    statementRow({ label: line.label, value: line.value, from: line.from, detail: line.detail }),
  );
  const total = gate.authorisedAmounts[0];
  if (total !== undefined) {
    rows.push(
      h('li', { class: 'stmt-row stmt-row--total' }, [
        h('span', { class: 'stmt-label' }, ['What we pay']),
        h('span', { class: 'stmt-value mono' }, [formatUsd(total)]),
      ]),
    );
  }
  right.appendChild(h('ul', { class: 'statement' }, rows));

  card.appendChild(h('div', { class: 'gate-cols' }, [left, right]));

  function say(message: string, bad = false): void {
    status.textContent = message;
    status.classList.toggle('gate-status--bad', bad);
  }

  /**
   * One decision, once.
   *
   * The buttons go dead the moment one is pressed and stay dead while the
   * request is open, so a second click cannot send a second decision on a
   * gate the server has already settled. They come back only if the decision
   * failed, because a failed decision means the caller is still waiting.
   */
  let deciding = false;
  async function decide(what: 'approval' | 'send back', run: () => Promise<GateResult>): Promise<void> {
    if (deciding) return;
    deciding = true;
    const wasDisabled = [btnApprove.disabled, btnApproveEdits.disabled, btnSendBack.disabled];
    btnApprove.disabled = true;
    btnApproveEdits.disabled = true;
    btnSendBack.disabled = true;
    say(`Sending the ${what}...`);
    const result = await run();
    if (result.ok) {
      say(gateTransport.live ? `${what} sent. Releasing the caller.` : `${what} recorded.`);
      return;
    }
    deciding = false;
    btnApprove.disabled = wasDisabled[0] ?? false;
    btnApproveEdits.disabled = wasDisabled[1] ?? false;
    btnSendBack.disabled = wasDisabled[2] ?? false;
    say(result.error, true);
  }

  // Editing the draft swaps which button is live: an edited draft cannot be
  // rubber-stamped through the plain approve path, it has to go through the
  // one that names the edit. Both buttons stay in the layout and cross-fade
  // rather than popping in and out, so the swap itself is feedback.
  textarea.addEventListener('input', () => {
    const unedited = textarea.value === gate.wanted;
    const empty = textarea.value.trim() === '';
    changeWrap.hidden = unedited;
    if (!unedited) changeBox.replaceChildren(...renderWordDiff(gate.wanted, textarea.value));
    const approveInactive = !unedited || empty;
    const editsInactive = unedited || empty;
    // The class drives the fade; `disabled` is what actually matters. A
    // button hidden only by opacity and pointer-events is still in the tab
    // order and still fires on Enter or Space, so an operator tabbing
    // through the gate could invoke the plain approve path on an edited
    // draft. Setting `disabled` closes that: out of the tab order, and inert.
    btnApprove.classList.toggle('is-inactive', approveInactive);
    btnApprove.disabled = approveInactive;
    btnApproveEdits.classList.toggle('is-inactive', editsInactive);
    btnApproveEdits.disabled = editsInactive;
    // An emptied draft cannot be approved by either path: there is nothing
    // left to speak, and a blank binding utterance is not a smaller version
    // of the offer, it is a different failure.
    btnSendBack.classList.toggle('is-emphasised', empty);
  });

  // Live, an edited draft cannot be approved at all.
  //
  // The wire settles a gate on allow or deny and carries no wording, so an
  // "approve my wording" would send the ORIGINAL sentence while the operator
  // watched their own edit on screen and believed it had been authorised.
  // That is a worse failure than the missing button. An edit goes back for a
  // redraft instead, and the edited text is offered as the reason, which is
  // exactly what the agent needs to write the next draft.
  if (gateTransport.live) {
    btnApproveEdits.title = 'On a live call, an edit goes back to the agent to say in its own turn.';
  }

  btnApprove.addEventListener('click', () => {
    void decide('approval', () => gateTransport.approve(gate, textarea.value));
  });
  btnApproveEdits.addEventListener('click', () => {
    if (gateTransport.live) {
      reasonBox.value = reasonBox.value.trim() === ''
        ? `Use this wording instead: ${textarea.value.trim()}`
        : reasonBox.value;
      say('Edited wording goes back to the agent. It is in the reason box below.', true);
      return;
    }
    void decide('approval', () => gateTransport.approve(gate, textarea.value));
  });
  btnSendBack.addEventListener('click', () => {
    void decide('send back', () => gateTransport.sendBack(gate, reasonBox.value));
  });
}

function renderGateApproved(ev: GateEvent): void {
  showGateLayer();
  const card = el('gate');
  card.className = 'gate gate--settled';
  card.replaceChildren(
    h('div', { class: 'gate-eyebrow' }, [ev.auto ? 'Approved automatically' : 'You approved it']),
    h('h2', { class: 'gate-h', id: 'gate-heading' }, ['The agent said this to the caller']),
    h('p', { class: 'gate-said' }, [ev.said ?? '']),
    ...(ev.reason ? [h('p', { class: 'gate-sub' }, [ev.reason])] : []),
  );
  hideGateLayerAfter(3200);
}

function renderGateSentBack(ev: GateEvent): void {
  showGateLayer();
  const card = el('gate');
  card.className = 'gate gate--settled';
  card.replaceChildren(
    h('div', { class: 'gate-eyebrow' }, ['You sent it back']),
    h('h2', { class: 'gate-h', id: 'gate-heading' }, ['The agent is writing the offer again']),
    ...(ev.reason ? [h('p', { class: 'gate-sub' }, [ev.reason])] : []),
  );
  hideGateLayerAfter(2400);
}

/**
 * Asks for the operator token, once per tab.
 *
 * Rendered in the gate card rather than at page load, so a console that is
 * only being watched never asks for a credential it does not need. Deciding
 * a gate needs one; watching a call does not.
 */
function renderTokenRow(parent: HTMLElement, onStored: () => void): void {
  const row = h('div', { class: 'gate-token' });
  row.appendChild(h('span', { class: 'field-label' }, ['Operator token, to decide a gate']));
  const input = h('input', {
    class: 'gate-token-input mono',
    type: 'password',
    placeholder: 'TELEPHONY_SHARED_SECRET from .env.local',
    autocomplete: 'off',
  });
  const save = h('button', { class: 'btn' }, ['Hold for this tab']);
  save.addEventListener('click', () => {
    const value = input.value.trim();
    if (value === '') return;
    writeToken(value);
    input.value = '';
    onStored();
  });
  row.appendChild(h('div', { class: 'gate-token-row' }, [input, save]));
  parent.appendChild(row);
}

function logDecision(t: number, words: string): void {
  el('decisions').appendChild(
    h('li', { class: 'decision' }, [
      h('span', { class: 'decision-t mono' }, [formatClock(t)]),
      h('span', {}, [words]),
    ]),
  );
}

/**
 * An operator's click becomes a real `GateEvent` through the same
 * `dispatch()` every wire or fixture event goes through, rather than
 * rendering directly. That keeps exactly one code path deciding what a
 * gate's outcome is, so a locally approved gate cannot be reopened or
 * reversed by a scripted event arriving after it (see `gateResolutions` on
 * `dispatch`), and the run log the counters read from always includes the
 * operator's own decisions.
 */
function resolveGateLocally(gate: GateState, said: string): void {
  dispatch({ type: 'gate', t: virtualNow(), id: gate.id, tool: gate.tool, status: 'approved', said });
}

function sendBackLocally(gate: GateState, reason: string): void {
  dispatch({
    type: 'gate', t: virtualNow(), id: gate.id, tool: gate.tool, status: 'sent_back',
    reason: reason.trim() === '' ? 'Sent back to work out again.' : reason.trim(),
  });
}

function onGate(ev: GateEvent): void {
  if (ev.status === 'opened') {
    currentGate = {
      id: ev.id,
      tool: ev.tool,
      wanted: ev.wanted ?? '',
      breakdown: ev.breakdown ?? [],
      sources: ev.sources ?? [],
      authorisedAmounts: ev.authorised_amounts ?? [],
    };
    adoptBreakdown(currentGate.breakdown);
    gateOpenedAtCallTime = ev.t;
    gateIsOpen = true;
    activityOverride = null;
    renderGateOpen(currentGate);
    applyScreen();
    tickGateHold();
    logDecision(ev.t, 'Offer put in front of you');
    return;
  }

  gateOpenedAtCallTime = null;
  gateHeldEl = null;
  gateIsOpen = false;

  if (ev.status === 'sent_back') {
    activityOverride = 'Writing the offer again';
    renderGateSentBack(ev);
    logDecision(ev.t, 'You sent the offer back');
    if (currentGate?.id === ev.id) currentGate = null;
    applyScreen();
    return;
  }

  // 'approved'. gate-3 in the recording has no prior 'opened' at all: it
  // resolves straight from a pre-authorisation, which is the point of
  // scoping one.
  activityOverride = null;
  renderGateApproved(ev);
  logDecision(
    ev.t,
    ev.auto ? 'Approved on its own, inside an amount you already approved' : 'You approved the offer',
  );
  if (currentGate?.id === ev.id) currentGate = null;
  applyScreen();
}

// ---------------------------------------------------------------------------
// Call header and session banner.

function onCall(ev: CallEvent): void {
  if (ev.status === 'started') {
    callEverStarted = true;
    callLive = true;
    callEndedAtCallTime = null;
    el('caller-name').textContent = ev.caller ?? 'Caller';
    el('claim-line').textContent = ev.claim_id ? `Claim ${ev.claim_id}` : '';
    applyScreen();
    return;
  }
  callLive = false;
  gateIsOpen = false;
  callEndedAtCallTime = ev.t;
  el('gate-layer').hidden = true;
  applyScreen();
}

function onSession(ev: SessionEvent): void {
  if (ev.status === 'suspended') {
    activityOverride = 'The line dropped. Everything is being held.';
    logDecision(ev.t, 'The line dropped');
  } else {
    activityOverride = 'Back on the line. Nothing was worked out again.';
    logDecision(ev.t, 'Caller rang back, nothing recalculated');
  }
  applyScreen();
}

// ---------------------------------------------------------------------------
// Counters footer. Generated from the run log on every event, never
// hard-coded, and held (not cleared) once the call ends.

function renderCounters(): void {
  const n = tally(numbersFromEvents(state.events));
  const u = tallyUtterances(utterancesFromEvents(state.events));

  el('counter-numbers').textContent =
    n.spoken === 0
      ? 'No numbers said yet.'
      : n.recalled > 0
        ? `${n.spoken} numbers said, and ${n.recalled} of them has no source.`
        : `${n.spoken} numbers said, every one traced to a source.`;

  el('counter-utterances').textContent =
    u.binding === 0
      ? 'No binding sentences yet.'
      : u.spokenUnapproved > 0
        ? `${u.binding} binding sentences, ${u.spokenUnapproved} said without approval.`
        : `${u.binding} binding ${u.binding === 1 ? 'sentence' : 'sentences'}, all approved before they were said.`;
}

// ---------------------------------------------------------------------------
// The harness indicator. Quiet, and never says more than it knows.

function setHarness(kind: 'up' | 'replay' | 'down' | 'wait', words: string): void {
  const node = el('harness');
  node.className = `harness harness--${kind}`;
  node.textContent = words;
}

async function nameTheHarness(): Promise<void> {
  try {
    const res = await fetch('/health');
    if (!res.ok) return;
    const body = (await res.json()) as { agent?: unknown };
    if (typeof body.agent === 'string' && body.agent !== '') {
      setHarness('up', `TrueForge harness connected · ${body.agent}`);
    }
  } catch {
    // The indicator already says what the event stream is doing. A failed
    // health probe is not worth contradicting it over.
  }
}

// ---------------------------------------------------------------------------
// Dispatch and replay.

interface ConsoleState {
  events: ConsoleEvent[];
}

const state: ConsoleState = { events: [] };

/** The status a gate id first resolved to, `'sent_back'` or `'approved'`.
 *  Once set it is final: whichever resolution reaches `dispatch()` first,
 *  an operator's click or the fixture's own scripted timeline, wins, and
 *  anything that would resolve the same id again is dropped rather than
 *  rendered. Without this, a locally approved gate could be silently
 *  reversed moments later by the fixture replaying its own scripted
 *  outcome for the same id. */
const gateResolutions = new Map<string, GateEvent['status']>();

/**
 * Fixture-only branch dependencies: gate-2's opening and gate-3's
 * pre-authorised approval, plus the two `number` events that presuppose
 * gate-1 was sent back, only make sense if the branch of the recorded call
 * they belong to is the one that actually happened. A live emitter never
 * needs this table, it only ever emits what actually occurred; this
 * recorded script schedules every branch's events regardless of what an
 * operator does with the ones already dispatched, which is exactly the gap
 * `dispatch()` closes below.
 */
function branchRequirement(ev: ConsoleEvent): { gateId: string; status: GateEvent['status'] } | null {
  if (ev.type === 'gate' && ev.id === 'gate-2') return { gateId: 'gate-1', status: 'sent_back' };
  if (ev.type === 'gate' && ev.id === 'gate-3') return { gateId: 'gate-2', status: 'approved' };
  if (ev.type === 'number' && ev.label === 'Net settlement, salvage retained') {
    return { gateId: 'gate-1', status: 'sent_back' };
  }
  if (ev.type === 'number' && ev.label === 'Offer validity') return { gateId: 'gate-1', status: 'sent_back' };
  // Everything said after the second gate resolves was said BECAUSE it
  // resolved that way. On the branch where an operator approves the first
  // draft instead, none of it happened, so none of it is transcribed.
  if (ev.type === 'transcript' && ev.t >= 102_000) return { gateId: 'gate-2', status: 'approved' };
  return null;
}

function dispatch(ev: ConsoleEvent): void {
  const requirement = branchRequirement(ev);
  if (requirement && gateResolutions.get(requirement.gateId) !== requirement.status) return;

  if (ev.type === 'gate' && ev.status !== 'opened') {
    if (gateResolutions.has(ev.id)) return;
    gateResolutions.set(ev.id, ev.status);
  }
  state.events.push(ev);
  switch (ev.type) {
    case 'call':
      onCall(ev);
      break;
    case 'hold':
      onHold(ev);
      break;
    case 'lane':
      onLane(ev);
      break;
    case 'lanes_summary':
      onLanesSummary(ev);
      break;
    case 'number':
      onNumber(ev);
      break;
    case 'gate':
      onGate(ev);
      break;
    case 'session':
      onSession(ev);
      break;
    case 'transcript':
      onTranscript(ev);
      break;
  }
  renderCounters();
  tickClocks();
}

function startReplay(events: ConsoleEvent[], speed: number, until: number | null): void {
  playbackSpeed = speed;
  playbackEpoch = Date.now();
  playbackOrigin = 0;

  if (until !== null) {
    for (const ev of events) {
      if (ev.t > until) break;
      dispatch(ev);
    }
    pausedAtCallTime = until;
    playbackEpoch = Date.now();
    playbackPaused = true;
    return;
  }

  for (const ev of events) {
    setTimeout(() => dispatch(ev), ev.t / speed);
  }
}

/** Re-anchors `virtualNow()` to a live event's own call-relative `t` rather
 *  than page-load time. Without this, connecting mid-call would show the
 *  call and hold clocks counting from when the browser tab opened instead
 *  of from when the call was answered, since `playbackOrigin` is otherwise
 *  only set by `startReplay()`. Re-anchoring on every event, not just the
 *  first, also keeps the clock tracking the server rather than drifting
 *  from it over a long call. */
function syncClockToLive(t: number): void {
  playbackOrigin = t;
  playbackEpoch = Date.now();
  playbackSpeed = 1;
  playbackPaused = false;
}

function startLive(url: string): void {
  const source = new EventSource(url);
  setHarness('wait', 'Reaching the TrueForge harness');
  source.addEventListener('open', () => {
    setHarness('up', 'TrueForge harness connected');
    void nameTheHarness();
  });
  source.addEventListener('error', () => {
    // EventSource reconnects on its own. Say what is true right now rather
    // than claiming a connection the browser is still retrying.
    setHarness('down', 'Lost the harness, reconnecting');
  });
  const onMessage = (msgEvent: MessageEvent): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(msgEvent.data));
    } catch {
      return;
    }
    if (!isConsoleEvent(parsed)) return;
    syncClockToLive(parsed.t);
    dispatch(parsed);
  };
  const types: ConsoleEvent['type'][] = [
    'lane', 'lanes_summary', 'number', 'gate', 'hold', 'session', 'call', 'transcript',
  ];
  for (const type of types) source.addEventListener(type, onMessage);
}

function main(): void {
  applyScreen();
  renderMoney();
  setInterval(tickClocks, 250);

  const params = new URLSearchParams(window.location.search);

  // Demo replay requires an explicit ?demo param, or ?speed / ?until.
  // Without any of those, the console connects live to /sse so the
  // operator sees real call data the moment they open the page.
  const demo = params.has('demo');
  const speedParam = params.get('speed');
  const untilParam = params.get('until');

  if (demo || speedParam !== null || untilParam !== null) {
    const speed = Number(speedParam ?? '1') || 1;
    const until = untilParam !== null && untilParam !== '' ? Number(untilParam) : null;
    // A recording has no caller to release, so a click resolves it here.
    gateTransport = replayTransport;
    setHarness('replay', 'Replaying a recorded call. Not a live line.');
    startReplay(recordedNorthvaneCall(), speed, until);
    return;
  }

  // Default: live mode. ?live=<url> overrides the endpoint.
  const liveParam = params.get('live');
  const liveUrl = liveParam && liveParam !== '1' ? liveParam : '/sse';
  // A real caller is on the line, so a click has to reach the process holding
  // them. The outcome comes back on this same stream.
  gateTransport = liveTransport;
  startLive(liveUrl);
}

// This file is imported under plain Node by test/loadable.test.ts, which
// walks every src module to catch a runtime-only crash that tsc cannot see
// (the project's own rule against enums and namespaces exists for the same
// reason). `typeof document` is the one safe way to ask "is a DOM here"
// without dereferencing an undeclared global, so importing this module
// under Node loads it without running it, and a browser still gets a
// console the moment the script tag executes.
if (typeof document !== 'undefined') {
  main();
}

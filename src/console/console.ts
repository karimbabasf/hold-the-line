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
 * By default this connects live to `/events`, so the operator sees real
 * call data the moment they open the page. Query parameters switch to the
 * recorded demo or change playback for development:
 *
 *   ?demo             replay `recordedNorthvaneCall()` in real time.
 *   ?speed=20         replay faster than real time (debugging, not demo).
 *   ?until=71000      dispatch every event with t <= 71000 instantly, then
 *                      freeze there. Used to capture docs/console.png with
 *                      the gate open and the hold clock already running.
 *   ?live=<url>       connect to a custom emitter URL instead of /events.
 *
 * Live, the gate buttons post to `/gate/decide` on the telephony process,
 * which is what actually releases a held caller. In replay they resolve the
 * fixture locally, because there is no held caller to release.
 *
 * None of these change the event contract in `events.ts`; they only
 * change how this file schedules dispatch.
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
} from './events.ts';
import { createGateClient, type GateResult } from './gate-client.ts';
import type { SettleLine } from '../settle/settle.ts';
import {
  formatNumberLine,
  formatUsd,
  formatUtteranceLine,
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

function formatNumberValue(ev: NumberEvent): string {
  if (ev.unit === 'percent') return `${ev.value}%`;
  if (ev.unit === 'days') return `${ev.value} ${ev.value === 1 ? 'day' : 'days'}`;
  return formatUsd(ev.value);
}

function tagText(ev: NumberEvent): string {
  if (ev.from === 'computed') return `computed · ${ev.run_id ?? 'no run id'}`;
  if (ev.from === 'record') return `record · ${ev.source ?? 'no source'}`;
  return 'RECALLED, NO SOURCE';
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
  el('call-clock').textContent = formatClock(callEndedAtCallTime ?? virtualNow());
  el('hold-clock').textContent = formatClock(currentHoldMs());
  tickGateHold();
}

// ---------------------------------------------------------------------------
// Lanes pane.

const laneRows = new Map<string, HTMLLIElement>();

function onLane(ev: LaneEvent): void {
  let row = laneRows.get(ev.tool);
  if (!row) {
    row = h('li', { class: 'lane-row' });
    el('lanes-list').appendChild(row);
    laneRows.set(ev.tool, row);
  }
  row.className = `lane-row lane-row--${ev.status}`;
  row.replaceChildren(
    h('span', { class: 'lane-dot' }),
    h('span', { class: 'lane-name' }, [ev.name]),
    h('span', { class: 'lane-elapsed mono' }, [
      ev.status === 'done' ? `${((ev.elapsed_ms ?? 0) / 1000).toFixed(1)}s` : 'running',
    ]),
    h('span', { class: 'lane-summary' }, [ev.summary ?? ev.tool]),
  );
}

function onLanesSummary(ev: LanesSummaryEvent): void {
  const p = (ev.parallel_ms / 1000).toFixed(1);
  const s = (ev.serial_ms / 1000).toFixed(1);
  el('lanes-counter').textContent = `${p}s parallel versus ${s}s serial`;
}

// ---------------------------------------------------------------------------
// Computed pane. Every number the agent holds. Nothing untagged: a missing
// `from` renders red rather than silently blending in.

function onNumber(ev: NumberEvent): void {
  const tagClass = ev.from === 'computed' ? 'tag--computed' : ev.from === 'record' ? 'tag--record' : 'tag--recalled';
  const tile = h('li', { class: `computed-tile${ev.from ? '' : ' computed-tile--recalled'}` }, [
    h('span', { class: 'computed-label' }, [ev.label]),
    h('span', { class: 'computed-value mono' }, [formatNumberValue(ev)]),
    h('span', { class: `computed-tag ${tagClass}` }, [tagText(ev)]),
  ]);
  el('computed-list').appendChild(tile);
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

const liveTransport: GateTransport = {
  live: true,
  approve: (gate) => gateClient.approve(gate.id),
  sendBack: (gate, reason) => gateClient.sendBack(gate.id, reason),
};

const gateClient = createGateClient({ token: () => readToken() ?? memoryToken });

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
// The hold clock in the header counts every kind of dead air. This one counts
// only the part an operator is causing by not deciding, which is the number
// that should make them uncomfortable.

let gateOpenedAtCallTime: number | null = null;
let gateHeldEl: HTMLElement | null = null;

function tickGateHold(): void {
  if (!gateHeldEl || gateOpenedAtCallTime === null) return;
  const heldMs = Math.max(0, virtualNow() - gateOpenedAtCallTime);
  gateHeldEl.textContent = `The caller has been waiting ${formatClock(heldMs)} on this decision.`;
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
  if (before === after) return [h('span', { class: 'diff-same' }, ['no change from the draft'])];
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

function renderBreakdownRow(line: SettleLine): HTMLLIElement {
  return h('li', { class: 'breakdown-row' }, [
    h('span', { class: 'breakdown-label' }, [line.label]),
    h('span', { class: 'breakdown-value mono' }, [formatUsd(line.value)]),
    h('span', { class: `computed-tag tag--${line.from}` }, [line.from]),
  ]);
}

function renderGateOpen(gate: GateState): void {
  el('gate-empty').hidden = true;
  const content = el('gate-content');
  content.hidden = false;
  content.replaceChildren();

  content.appendChild(
    h('div', { class: 'gate-alert' }, ['HIGH RISK: BINDING SETTLEMENT OFFER, IRREVERSIBLE ONCE APPROVED']),
  );
  // TrueForge answers any further caller utterance with 422 while a gate is
  // open. This is not a hold in the ordinary sense, the line is stopped, so
  // the console says that plainly rather than leaving it implied.
  content.appendChild(
    h('div', { class: 'gate-halted' }, ['The line is halted. The caller cannot be spoken to again until this resolves.']),
  );
  // Dead air an operator is causing by not deciding yet, counted separately
  // from the call's own hold clock so it cannot hide inside it.
  gateHeldEl = h('div', { class: 'gate-held mono' }, ['The caller has been waiting 0:00 on this decision.']);
  content.appendChild(gateHeldEl);
  content.appendChild(h('div', { class: 'gate-meta mono' }, [`gate ${gate.id}  ·  ${gate.tool}`]));

  content.appendChild(h('label', { class: 'field-label' }, ['Draft utterance, editable']));
  const textarea = h('textarea', { class: 'gate-wanted', rows: '4' });
  textarea.value = gate.wanted;
  content.appendChild(textarea);

  content.appendChild(h('label', { class: 'field-label' }, ['Change from what the agent drafted']));
  const diff = h('div', { class: 'gate-diff' });
  content.appendChild(diff);

  content.appendChild(h('label', { class: 'field-label' }, ['Settlement breakdown']));
  const breakdownList = h(
    'ul',
    { class: 'breakdown-list' },
    gate.breakdown.map(renderBreakdownRow),
  );
  content.appendChild(breakdownList);

  content.appendChild(h('label', { class: 'field-label' }, ['Source records']));
  content.appendChild(h('div', { class: 'sources-row mono' }, [gate.sources.join('   ·   ')]));

  if (gate.authorisedAmounts.length > 0) {
    content.appendChild(
      h('div', { class: 'authorised-row mono' }, [
        `pre-authorises: ${gate.authorisedAmounts.map(formatUsd).join(', ')}`,
      ]),
    );
  }

  content.appendChild(h('label', { class: 'field-label' }, ['Reason, if you are sending it back']));
  const reasonBox = h('textarea', {
    class: 'gate-reason-input',
    rows: '2',
    placeholder: 'the agent reads this and redrafts from it',
  });
  content.appendChild(reasonBox);

  const btnApprove = h('button', { class: 'btn btn--approve' }, ['Approve']);
  const btnApproveEdits = h('button', { class: 'btn btn--approve-edits is-inactive' }, ['Approve with edits']);
  btnApproveEdits.disabled = true;
  const btnSendBack = h('button', { class: 'btn btn--send-back' }, ['Send back to recompute']);
  content.appendChild(h('div', { class: 'gate-buttons' }, [btnApprove, btnApproveEdits, btnSendBack]));

  const status = h('div', { class: 'gate-status mono' });
  content.appendChild(status);

  if (gateTransport.live && (readToken() ?? memoryToken) === null) {
    renderTokenRow(content, () => {
      say('token held for this tab. the buttons will reach the server now.');
    });
  }

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
  async function decide(what: 'approve' | 'send back', run: () => Promise<GateResult>): Promise<void> {
    if (deciding) return;
    deciding = true;
    const wasDisabled = [btnApprove.disabled, btnApproveEdits.disabled, btnSendBack.disabled];
    btnApprove.disabled = true;
    btnApproveEdits.disabled = true;
    btnSendBack.disabled = true;
    say(`sending the ${what}...`);
    const result = await run();
    if (result.ok) {
      say(gateTransport.live ? `${what} sent. releasing the caller.` : `${what} recorded.`);
      return;
    }
    deciding = false;
    btnApprove.disabled = wasDisabled[0] ?? false;
    btnApproveEdits.disabled = wasDisabled[1] ?? false;
    btnSendBack.disabled = wasDisabled[2] ?? false;
    say(result.error, true);
  }

  const renderDiff = (): void => diff.replaceChildren(...renderWordDiff(gate.wanted, textarea.value));
  renderDiff();

  // Editing the draft swaps which button is live: an edited draft cannot be
  // rubber-stamped through the plain "Approve" path, it has to go through
  // "Approve with edits". Both buttons stay in the layout and cross-fade
  // (see .is-inactive in index.html) rather than popping in and out, so the
  // swap itself is a piece of feedback, not a layout jump.
  textarea.addEventListener('input', () => {
    renderDiff();
    const unedited = textarea.value === gate.wanted;
    const empty = textarea.value.trim() === '';
    const approveInactive = !unedited || empty;
    const editsInactive = unedited || empty;
    // The class drives the fade; `disabled` is what actually matters. A
    // button hidden only by opacity and pointer-events is still in the tab
    // order and still fires on Enter or Space, so an operator tabbing
    // through the gate could invoke the plain "Approve" path on an edited
    // draft, or "Approve with edits" before anything was edited. Setting
    // `disabled` closes both: out of the tab order, and inert to any input.
    btnApprove.classList.toggle('is-inactive', approveInactive);
    btnApprove.disabled = approveInactive;
    btnApproveEdits.classList.toggle('is-inactive', editsInactive);
    btnApproveEdits.disabled = editsInactive;
    // An emptied draft cannot be approved by either path: there is nothing
    // left to speak, and a blank binding utterance is not a smaller version
    // of the offer, it is a different failure than the one this button row
    // already guards against.
    btnSendBack.classList.toggle('is-emphasised', empty);
  });

  // Live, an edited draft cannot be approved at all.
  //
  // The wire settles a gate on allow or deny and carries no wording, so an
  // "approve with edits" would send the ORIGINAL sentence while the operator
  // watched their own edit on screen and believed it had been authorised.
  // That is a worse failure than the missing button. An edit goes back for a
  // redraft instead, and the edited text is offered as the reason, which is
  // exactly what the agent needs to write the next draft.
  if (gateTransport.live) {
    btnApproveEdits.title = 'editing a draft sends it back for a redraft on this wire';
  }

  btnApprove.addEventListener('click', () => {
    void decide('approve', () => gateTransport.approve(gate, textarea.value));
  });
  btnApproveEdits.addEventListener('click', () => {
    if (gateTransport.live) {
      reasonBox.value = reasonBox.value.trim() === ''
        ? `use this wording instead: ${textarea.value.trim()}`
        : reasonBox.value;
      say('edited drafts go back for a redraft. the wording is in the reason below.', true);
      return;
    }
    void decide('approve', () => gateTransport.approve(gate, textarea.value));
  });
  btnSendBack.addEventListener('click', () => {
    void decide('send back', () => gateTransport.sendBack(gate, reasonBox.value));
  });
}

function renderGateApproved(ev: GateEvent): void {
  el('gate-empty').hidden = true;
  const content = el('gate-content');
  content.hidden = false;
  const rows: Array<Node | string> = [
    h('div', { class: 'gate-alert gate-alert--approved' }, [
      ev.auto ? 'AUTO-APPROVED, PRE-AUTHORISED AMOUNT' : 'APPROVED, SPOKEN VERBATIM',
    ]),
    h('div', { class: 'gate-meta mono' }, [`gate ${ev.id}  ·  ${ev.tool}`]),
    h('p', { class: 'gate-said' }, [ev.said ?? '']),
  ];
  if (ev.reason) rows.push(h('p', { class: 'gate-reason' }, [ev.reason]));
  content.replaceChildren(...rows);
}

/**
 * Asks for the operator token, once per tab.
 *
 * Rendered in the gate pane rather than at page load, so a console that is
 * only being watched never asks for a credential it does not need. Deciding
 * a gate needs one; watching a call does not.
 */
function renderTokenRow(parent: HTMLElement, onStored: () => void): void {
  const row = h('div', { class: 'gate-token' });
  row.appendChild(h('label', { class: 'field-label' }, ['Operator token, to decide a gate']));
  const input = h('input', {
    class: 'gate-token-input mono',
    type: 'password',
    placeholder: 'TELEPHONY_SHARED_SECRET from .env.local',
    autocomplete: 'off',
  });
  const save = h('button', { class: 'btn btn--approve-edits' }, ['Hold for this tab']);
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

function renderGateAwaiting(message: string): void {
  el('gate-content').hidden = true;
  const empty = el('gate-empty');
  empty.hidden = false;
  empty.textContent = message;
}

function logGateHistory(t: number, id: string, label: string): void {
  el('gate-history').appendChild(h('li', { class: 'gate-history-row mono' }, [`${formatClock(t)}  ${id}  ${label}`]));
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
    reason: reason.trim() === '' ? 'sent back to recompute (operator)' : reason.trim(),
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
    gateOpenedAtCallTime = ev.t;
    renderGateOpen(currentGate);
    tickGateHold();
    logGateHistory(ev.t, ev.id, 'opened');
    return;
  }

  if (ev.status === 'sent_back') {
    gateOpenedAtCallTime = null;
    gateHeldEl = null;
    renderGateAwaiting(ev.reason ? `Sent back to recompute. ${ev.reason}` : 'Sent back to recompute.');
    logGateHistory(ev.t, ev.id, 'sent back');
    if (currentGate?.id === ev.id) currentGate = null;
    return;
  }

  // 'approved'. gate-3 in the recording has no prior 'opened' at all: it
  // resolves straight from a pre-authorisation, which is the point of
  // scoping one.
  gateOpenedAtCallTime = null;
  gateHeldEl = null;
  renderGateApproved(ev);
  logGateHistory(ev.t, ev.id, ev.auto ? 'auto-approved' : 'approved');
  if (currentGate?.id === ev.id) currentGate = null;
}

// ---------------------------------------------------------------------------
// Call header and session banner.

function onCall(ev: CallEvent): void {
  const pill = el('call-status');
  if (ev.status === 'started') {
    el('claim-id').textContent = ev.claim_id ?? '';
    el('caller-name').textContent = ev.caller ?? '';
    pill.textContent = 'ON CALL';
    pill.className = 'pill pill--live';
    return;
  }
  pill.textContent = 'CALL ENDED, COUNTERS HELD';
  pill.className = 'pill pill--ended';
  el('counters').classList.add('counters--final');
  callEndedAtCallTime = ev.t;
}

function onSession(ev: SessionEvent): void {
  const pill = el('session-pill');
  pill.hidden = false;
  if (ev.status === 'suspended') {
    pill.textContent = `SESSION ${ev.session_id.toUpperCase()} SUSPENDED`;
    pill.className = 'pill pill--suspended';
    return;
  }
  const runIds = ev.run_ids ?? [];
  pill.textContent = `RESUMED, same run ids (${runIds.join(', ')}), nothing recomputed`;
  pill.className = 'pill pill--resumed';
}

// ---------------------------------------------------------------------------
// Counters footer, Task 8. Generated from the run log on every event, never
// hard-coded, and held (not cleared) once the call ends.

function renderCounters(): void {
  const numberTally = tally(numbersFromEvents(state.events));
  const utteranceTally = tallyUtterances(utterancesFromEvents(state.events));
  el('counter-numbers').textContent = formatNumberLine(numberTally);
  el('counter-utterances').textContent = formatUtteranceLine(utteranceTally);
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
  const types: ConsoleEvent['type'][] = ['lane', 'lanes_summary', 'number', 'gate', 'hold', 'session', 'call'];
  for (const type of types) source.addEventListener(type, onMessage);
}

function main(): void {
  setInterval(tickClocks, 250);

  const params = new URLSearchParams(window.location.search);

  // Demo replay requires an explicit ?demo param, or ?speed / ?until.
  // Without any of those, the console connects live to /events so the
  // operator sees real call data the moment they open the page.
  const demo = params.has('demo');
  const speedParam = params.get('speed');
  const untilParam = params.get('until');

  if (demo || speedParam !== null || untilParam !== null) {
    const speed = Number(speedParam ?? '1') || 1;
    const until = untilParam !== null && untilParam !== '' ? Number(untilParam) : null;
    // A recording has no caller to release, so a click resolves it here.
    gateTransport = replayTransport;
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

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
 * By default this replays `recordedNorthvaneCall()` from `events.ts` in
 * real time, so the console is demonstrable with no live call and no
 * server. Two query parameters change that for development:
 *
 *   ?speed=20        replay faster than real time (debugging, not demo).
 *   ?until=71000     dispatch every event with t <= 71000 instantly, then
 *                     freeze there. Used to capture docs/console.png with
 *                     the gate open and the hold clock already running.
 *   ?live=1          connect to a real emitter at /events instead of
 *                     replaying the fixture, once one exists.
 *
 * None of the three change the event contract in `events.ts`; they only
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

  const btnApprove = h('button', { class: 'btn btn--approve' }, ['Approve']);
  const btnApproveEdits = h('button', { class: 'btn btn--approve-edits is-inactive' }, ['Approve with edits']);
  btnApproveEdits.disabled = true;
  const btnSendBack = h('button', { class: 'btn btn--send-back' }, ['Send back to recompute']);
  content.appendChild(h('div', { class: 'gate-buttons' }, [btnApprove, btnApproveEdits, btnSendBack]));

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

  // This is a replay of a recorded call, not a live backend, so these
  // buttons resolve the gate locally rather than posting anywhere. If the
  // operator acts before the fixture's own scripted resolution for this id
  // would have fired, theirs wins and the later scripted one is dropped
  // (see `gateResolutions` on `dispatch`); acting after it is a no-op, the
  // id is already resolved. `?live=1` replaces this with a real POST to the
  // emitter once one exists; the event shape it should send back is the
  // same `GateEvent` this file already knows how to render.
  btnApprove.addEventListener('click', () => resolveGateLocally(gate, textarea.value));
  btnApproveEdits.addEventListener('click', () => resolveGateLocally(gate, textarea.value));
  btnSendBack.addEventListener('click', () => sendBackLocally(gate));
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

function sendBackLocally(gate: GateState): void {
  dispatch({
    type: 'gate', t: virtualNow(), id: gate.id, tool: gate.tool, status: 'sent_back',
    reason: 'sent back to recompute (operator)',
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
    renderGateOpen(currentGate);
    logGateHistory(ev.t, ev.id, 'opened');
    return;
  }

  if (ev.status === 'sent_back') {
    renderGateAwaiting(ev.reason ? `Sent back to recompute. ${ev.reason}` : 'Sent back to recompute.');
    logGateHistory(ev.t, ev.id, 'sent back');
    if (currentGate?.id === ev.id) currentGate = null;
    return;
  }

  // 'approved'. gate-3 in the recording has no prior 'opened' at all: it
  // resolves straight from a pre-authorisation, which is the point of
  // scoping one.
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
  const live = params.get('live');
  if (live) {
    startLive(live === '1' ? '/events' : live);
    return;
  }

  const speed = Number(params.get('speed') ?? '1') || 1;
  const untilParam = params.get('until');
  const until = untilParam !== null && untilParam !== '' ? Number(untilParam) : null;
  startReplay(recordedNorthvaneCall(), speed, until);
}

main();

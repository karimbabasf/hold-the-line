# hold-the-line Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A voice agent that answers a total-loss insurance claim call, computes the settlement in a sandbox, and puts the caller on hold while a human operator approves the exact sentence that commits the company to a dollar figure.

**Architecture:** Telnyx AI Assistant owns voice (STT, TTS, turn taking) and calls an OpenAI-shaped `/chat/completions` endpoint we host. That endpoint is backed by a TrueForge session, so the harness runs the agent loop. A single MCP server exposes claim lookups and the gated utterance tool. An operator console subscribes to TrueForge turn events over SSE and answers `tool.approval_required`. No media-stream bridge is written by hand.

**Tech Stack:** Node 22, TypeScript (ESM, `--experimental-strip-types`), `node:test`, TrueForge v0.1.4 on :8790, Telnyx AI Assistant, cloudflared for the public webhook URL.

**Spec:** `docs/superpowers/specs/2026-08-28-northvane-scenario.md`

## Global Constraints

- **Every number the agent speaks is either computed in the sandbox or traced to a fixture field. None is recalled from the model.** This invariant is the project. It is enforced in code and displayed as a live counter.
- **The agent may not speak a binding sentence directly.** To say one it calls `offer.state_settlement`, whose argument IS the sentence. There must be no code path from model text generation to TTS for a binding utterance.
- **All customer data is fictional.** Northvane Mutual, Daniel Ortiz, Cascade Auto Finance. No Pakkr data, no real customer data, no real keys in the repo.
- **Secrets live only in `.env.local`**, which `.gitignore` already blocks. `.env.example` carries names and no values.
- **Every substantive change goes through a GitHub PR reviewed by Qodo before merge.** Direct pushes to `main` do not count as reviewed work. Fix every valid High finding, or dismiss it in the Qodo thread with a reason.
- **No em dashes or en dashes anywhere**, code, comments, docs, commits, PR bodies. Use commas, colons, parentheses.
- Node `>=22`. TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Money is handled as integer cents internally and formatted only at the edges. Never compare or accumulate floats.
- **Build ends 13:45 Saturday**, not 14:00. A 2:15 call needs three takes.

---

## The Qodo ritual, on every single PR

Best Code Quality is judged on the review conversation, not just the code. Judges open the repo and read the threads. A thread where you disagreed with a finding and said why reads better than a clean run nobody replied to. **A silent fix scores worse than a question.**

Run this on every PR in this order. It takes about four minutes.

1. **`/describe`** as the first comment. Let Qodo write the PR description, then edit it rather than writing from scratch. Free, and it makes the PR history readable to a judge skimming twenty repos.
2. **`/review`** for the severity-ranked pass.
3. **`/improve`** for concrete code suggestions. Apply the ones that are right. **Reply to the ones that are wrong instead of ignoring them.**
4. **`/ask` one question you already suspect the answer to**, before Qodo raises it. This is the highest-scoring move available and almost nobody does it.
5. Push the fixes, then **`/agentic_review`** again so the thread shows a follow-up review against the final code.

**Fix every valid High. If a High is wrong, deferred, or intentional, say so in the thread with the reason.** Medium and Low are an engineering call, but say which call you made.

### How to write the comments

Short, direct, lowercase, no padding. One question per comment. No "Thanks for the review!", no restating what Qodo said back at it. Real examples to copy the register from:

```
/ask does the sse parser drop the last frame if the stream ends without a blank line?
```
```
/ask money is integer cents everywhere else but this one is a float. worth changing or fine here?
```
```
why is this a high and not a medium? nothing downstream reads that value.
```
```
not fixing this one. the delayMs stagger is deliberate demo latency, it is commented as such. real lanes would be async anyway.
```
```
good catch, wrong on my part. fixed in 3f2a1c9.
```
```
/ask two calls from the same number at once would both write the session file. is that a real race here or am i overthinking it?
```

**Per PR, aim for: one `/describe`, one `/improve`, at least one question asked before Qodo complains, at least one finding pushed back on with a reason, and one follow-up review.** If a PR has nothing worth disagreeing with, that is a sign the PR is too small to be worth a judge's time.

---

### Task 1: Telephony round trip

The single biggest scope risk. Prove it Friday night so Saturday's 12:00 checkpoint is already passed. Nothing else in this plan matters if a phone call cannot reach our code.

**Files:**
- Create: `src/telephony/chat-endpoint.ts`
- Create: `src/telephony/server.ts`
- Create: `scripts/telnyx-assistant.mts`
- Test: `test/chat-endpoint.test.ts`

**Interfaces:**
- Consumes: `TrueForgeClient` from `src/trueforge/client.ts` (merged in PR 1).
- Produces: `createChatEndpoint(deps): (req: Request) => Promise<Response>` handling `POST /v1/chat/completions` in OpenAI shape, streaming SSE deltas.

- [ ] **Step 1: Write the failing test**

```ts
// test/chat-endpoint.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatEndpoint } from '../src/telephony/chat-endpoint.ts';

test('returns OpenAI-shaped SSE deltas for a user turn', async () => {
  const handler = createChatEndpoint({
    runTurn: async function* () {
      yield { type: 'message.delta', text: 'It is a total loss.' };
    },
  });
  const res = await handler(new Request('http://x/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'hold-the-line',
      stream: true,
      messages: [{ role: 'user', content: 'Claim 40218' }],
    }),
  }));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /"delta":\{"content":"It is a total loss\."\}/);
  assert.match(body, /data: \[DONE\]/);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test --experimental-strip-types test/chat-endpoint.test.ts`
Expected: FAIL, cannot find module `chat-endpoint.ts`.

- [ ] **Step 3: Implement the endpoint**

`createChatEndpoint({ runTurn })` parses the OpenAI request, takes the last user message, calls `runTurn(text)`, and re-emits each yielded delta as an OpenAI streaming chunk:

```ts
const chunk = (content: string) => `data: ${JSON.stringify({
  id: 'chatcmpl-htl', object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000), model: 'hold-the-line',
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
})}\n\n`;
```

Terminate with a `finish_reason: 'stop'` chunk then `data: [DONE]\n\n`. Content type `text/event-stream`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test --experimental-strip-types test/chat-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the real TrueForge session behind it**

`src/telephony/server.ts` starts `node:http` on `PORT` (default 8791), mounts the endpoint, and supplies a `runTurn` that calls `TrueForgeClient.streamTurn` and maps harness message deltas to text. Park approval events for Task 5; for now log them.

- [ ] **Step 6: Expose it and point Telnyx at it**

```bash
cloudflared tunnel --url http://localhost:8791   # copy the https URL
node --env-file=.env.local scripts/telnyx-assistant.mts --create
```

`scripts/telnyx-assistant.mts` creates a NEW assistant (never touches the two Pakkr ones) via `POST /v2/ai/assistants`, mirroring the working config exactly: voice `Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02` at speed 1, transcription `deepgram/flux`, `enabled_features: ["telephony"]`, `background_audio` silence at 0.3, and `api_base_url` set to `${PUBLIC_BASE_URL}/v1`. Then assign `+14157238926` to it. Print the assistant id and write nothing secret to stdout.

- [ ] **Step 7: Verify with a real call**

Call +1 415 723 8926 from a mobile. Say "hello". Expected: the assistant speaks a reply that came from TrueForge, and `server.ts` logs one inbound `/v1/chat/completions` request. **This is the checkpoint. If it does not pass, stop and fall back to a browser softphone, and say so honestly in the video.**

- [ ] **Step 8: Commit and open the PR**

```bash
git checkout -b feat/telephony-round-trip
git add src/telephony test/chat-endpoint.test.ts scripts/telnyx-assistant.mts
git commit -m "Add OpenAI-shaped endpoint backed by a TrueForge session"
git push -u origin feat/telephony-round-trip && gh pr create --fill
```

---

### Task 2: Fixtures and typed loader

**Files:**
- Create: `fixtures/policy.json`, `fixtures/claim.json`, `fixtures/vehicle.json`, `fixtures/comps.json`, `fixtures/state_rules.json`
- Create: `src/data/fixtures.ts`
- Test: `test/fixtures.test.ts`

**Interfaces:**
- Produces: `loadPolicy()`, `loadClaim()`, `loadVehicle()`, `loadComps()`, `loadStateRules()`, and the exported types `Policy`, `Claim`, `Vehicle`, `Comp`, `StateRule`.

- [ ] **Step 1: Copy the five fixture files verbatim from spec section 5**

Copy the JSON blocks from `docs/superpowers/specs/2026-08-28-northvane-scenario.md` section 5 exactly. **Do not retype the numbers.** Every figure in Task 3 reconciles against these values, and a single mistyped digit breaks the on-screen breakdown that a judge will pause the video to check.

- [ ] **Step 2: Write the failing test**

```ts
// test/fixtures.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClaim, loadStateRules, loadVehicle } from '../src/data/fixtures.ts';

test('fixtures carry the exact values the settlement reconciles against', () => {
  assert.equal(loadClaim().repair_estimate, 16780.00);
  assert.equal(loadVehicle().lien.per_diem, 1.84);
  assert.equal(loadVehicle().lien.principal, 8699.72);
  assert.equal(loadStateRules().total_loss_threshold_pct, 75.0);
  assert.equal(loadStateRules().sales_tax_pct, 8.6);
  assert.equal(loadStateRules().mileage_adjustment_per_mile, 0.085);
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `node --test --experimental-strip-types test/fixtures.test.ts`
Expected: FAIL, cannot find module `fixtures.ts`.

- [ ] **Step 4: Implement the loader**

Read each file with `readFileSync` relative to the module URL, `JSON.parse`, and return it typed. Cache in a module-level `Map` so five concurrent lanes do not each hit the disk.

- [ ] **Step 5: Run the test and confirm it passes**

- [ ] **Step 6: Commit**

```bash
git add fixtures src/data test/fixtures.test.ts
git commit -m "Add Northvane fixtures and typed loader"
```

---

### Task 3: Settlement engine

The sandbox script. Spec section 7 warns that one line of arithmetic makes the room call this a prompt with extra steps, so this is thirty to forty real lines: comp mileage adjustment, threshold rule, per-diem date maths.

**Files:**
- Create: `src/settle/settle.ts`
- Test: `test/settle.test.ts`

**Interfaces:**
- Consumes: `loadClaim`, `loadVehicle`, `loadComps`, `loadStateRules`, `loadPolicy` from Task 2.
- Produces:

```ts
export interface SettleLine { label: string; value: number; from: 'computed' | 'record'; detail: string }
export interface SettleResult {
  is_total_loss: boolean;
  acv: number; ratio_pct: number; payoff: number; net: number;
  lines: SettleLine[];       // drives the on-screen breakdown, must sum to net
  run_id: string;
}
export function settle(opts: { retain_salvage: boolean; through_date: string }): SettleResult;
```

- [ ] **Step 1: Write the failing reconciliation test**

Every expected value below is verified against spec section 4. Do not adjust them to match an implementation; fix the implementation.

```ts
// test/settle.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { settle } from '../src/settle/settle.ts';

test('cash settlement reconciles to 13,481.12', () => {
  const r = settle({ retain_salvage: false, through_date: '2026-10-02' });
  assert.equal(r.acv, 21340.00);
  assert.equal(r.ratio_pct, 78.6);
  assert.equal(r.is_total_loss, true);
  assert.equal(r.payoff, 8764.12);
  assert.equal(r.net, 13481.12);
});

test('salvage retention nets 9,180.12', () => {
  const r = settle({ retain_salvage: true, through_date: '2026-10-02' });
  assert.equal(r.net, 9180.12);
});

test('every line is attributed and the breakdown sums to the spoken figure', () => {
  const r = settle({ retain_salvage: false, through_date: '2026-10-02' });
  for (const l of r.lines) {
    assert.ok(l.from === 'computed' || l.from === 'record', `${l.label} unattributed`);
    assert.ok(l.detail.length > 0, `${l.label} has no provenance detail`);
  }
  const summed = r.lines.reduce((a, l) => a + l.value, 0);
  assert.equal(Math.round(summed * 100) / 100, r.net);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test --experimental-strip-types test/settle.test.ts`
Expected: FAIL, cannot find module `settle.ts`.

- [ ] **Step 3: Implement, in this order**

1. Adjust each comp to the subject's 52,400 miles: `list_price + (comp.mileage - 52400) * 0.085`.
2. Mean the three adjusted comps, which gives 21,485.00.
3. `acv = mean - sum(prior_damage.deduction) + sum(options.value)` = 21,485.00 - 640.00 + 495.00 = 21,340.00.
4. `ratio_pct = round(repair_estimate / acv * 100, 1)` = 78.6. Total loss when `ratio_pct >= total_loss_threshold_pct`.
5. `days = whole days between principal_as_of and through_date` = 35 for 2026-08-28 to 2026-10-02. Compute in UTC from date-only strings so a local timezone cannot shift the count.
6. `payoff = principal + per_diem * days` = 8,764.12.
7. `gross = acv + round(acv * sales_tax_pct/100, 2) + title_fee + reg_fee` = 23,245.24.
8. `net = gross - deductible_collision - payoff` = 13,481.12; if `retain_salvage`, subtract `salvage_bid` 4,301.00 to give 9,180.12.

Push a `SettleLine` for every step with its `from` and `detail`. Generate `run_id` as a short ULID-ish string; the console shows it beside each computed number and it is how "nothing was recomputed" is proved after the reconnect.

- [ ] **Step 4: Run the tests and confirm all three pass**

- [ ] **Step 5: Commit**

```bash
git add src/settle test/settle.test.ts
git commit -m "Add settlement engine with per-line provenance"
```

---

### Task 4: MCP server with the safe read tools

**Files:**
- Create: `src/mcp/server.ts`, `src/mcp/lanes.ts`
- Test: `test/lanes.test.ts`

**Interfaces:**
- Produces: an MCP server over HTTP exposing `policy.lookup`, `claim.get`, `vehicle.get`, `valuation.comps`, `lienholder.payoff_quote`, `claims_history.get`, `state_rules.get`, `yard.storage_status`. Also `LANES: LaneDef[]` where `LaneDef = { name: string; tool: string; args: unknown; delayMs: number }`.

- [ ] **Step 1: Define the five lanes as data, never as five call sites**

```ts
// src/mcp/lanes.ts
export const LANES = [
  { name: 'policy and deductible', tool: 'policy.lookup',           args: { phone: '+14155550142' }, delayMs: 1100 },
  { name: 'valuation comps',       tool: 'valuation.comps',         args: { vin: '4S4BTAFC7M3201884' }, delayMs: 1600 },
  { name: 'lienholder payoff',     tool: 'lienholder.payoff_quote', args: { loan_id: 'CAF-9920431', through_date: '2026-10-02' }, delayMs: 2200 },
  { name: 'prior damage and history', tool: 'claims_history.get',   args: { vin: '4S4BTAFC7M3201884' }, delayMs: 2800 },
  { name: 'state rules',           tool: 'state_rules.get',         args: { state: 'AZ' }, delayMs: 3400 },
] as const;
```

Spec section 7 warns that lanes returning in 200ms kill the parallel argument on camera. The `delayMs` staggering is deliberate demo latency, and it must be commented as such in the file so no reviewer mistakes it for a bug.

- [ ] **Step 2: Write the failing test**

```ts
// test/lanes.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { LANES } from '../src/mcp/lanes.ts';
import { runLanes } from '../src/mcp/server.ts';

test('lanes run concurrently, not serially', async () => {
  const started = Date.now();
  const res = await runLanes(LANES, async (lane) => {
    await new Promise((r) => setTimeout(r, lane.delayMs));
    return lane.name;
  });
  const elapsed = Date.now() - started;
  const serial = LANES.reduce((a, l) => a + l.delayMs, 0);   // 11100
  assert.equal(res.results.length, 5);
  assert.ok(elapsed < serial / 2, `took ${elapsed}ms, serial would be ${serial}ms`);
  assert.equal(res.serial_ms, serial);
  assert.ok(res.parallel_ms >= 3400 && res.parallel_ms < serial);
});
```

- [ ] **Step 3: Run it and confirm it fails**

- [ ] **Step 4: Implement `runLanes` with `Promise.all` and return `{ results, parallel_ms, serial_ms }`**

`serial_ms` is the sum of observed durations, not the sum of configured delays, so the counter stays honest if a lane runs slow.

- [ ] **Step 5: Implement the MCP server**, each tool reading from Task 2's loader and sleeping its lane delay.

- [ ] **Step 6: Register it with TrueForge**

```bash
curl -s -X POST http://localhost:8790/api/v1/settings/mcp-servers \
  -H 'content-type: application/json' \
  -d '{"name":"northvane","url":"http://localhost:8792/mcp"}'
curl -s http://localhost:8790/api/v1/mcp-servers/northvane/tools | head -40
```

Expected: the eight safe tools listed. **TrueForge takes MCP servers by remote URL only, so a stdio server will not register.**

- [ ] **Step 7: Run the tests and commit**

```bash
git add src/mcp test/lanes.test.ts
git commit -m "Add MCP server, five lanes as config, concurrent fan-out"
```

---

### Task 5: The gated utterance tool and the approval loop

The centrepiece. Gets more build time than anything else.

**Files:**
- Modify: `src/mcp/server.ts`
- Create: `src/mcp/gated.ts`
- Test: `test/gated.test.ts`

**Interfaces:**
- Consumes: `TrueForgeClient.resolveApproval` from PR 1, `settle` from Task 3.
- Produces: `offer.state_settlement(claim_id, utterance, authorised_amounts)` plus `pendingGate()` and `approveGate(finalText)` used by the console in Task 8.

- [ ] **Step 1: Write the failing test for the pre-authorisation scope**

```ts
// test/gated.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { isPreAuthorised } from '../src/mcp/gated.ts';

test('an amount inside the approved utterance needs no second gate', () => {
  assert.equal(isPreAuthorised(13481.12, [13481.12, 9180.12]), true);
  assert.equal(isPreAuthorised(9180.12, [13481.12, 9180.12]), true);
});

test('any other amount re-fires the gate', () => {
  assert.equal(isPreAuthorised(13481.13, [13481.12, 9180.12]), false);
  assert.equal(isPreAuthorised(0, [13481.12, 9180.12]), false);
  assert.equal(isPreAuthorised(20000, [13481.12, 9180.12]), false);
});
```

- [ ] **Step 2: Run it and confirm it fails**

- [ ] **Step 3: Implement `isPreAuthorised` by comparing integer cents**, never floats.

- [ ] **Step 4: Mark the tool gated in the agent definition**

```bash
curl -s -X POST http://localhost:8790/api/v1/agents -H 'content-type: application/json' -d @agent.json
```

`agent.json` sets `require_approval_for_tools` to the five gated names from spec section 6. Verify by starting a turn that reaches the tool and confirming a `tool.approval_required` event arrives.

- [ ] **Step 4b: Write the agent instructions, which is where the invariant is enforced at the model level**

The gate is the hard stop, but the instructions are what stop the agent walking into it constantly. `agent.json` instructions must state:

1. **Never state a figure you did not obtain from a tool.** To say any number, either read it from a record or compute it with `sandbox.run`. Never do arithmetic in your head.
2. **Never speak a sentence that commits Northvane to an amount, a deadline, or an outcome.** To say one, call `offer.state_settlement` with the sentence as the `utterance` argument, then say exactly what it returns.
3. **Open by naming that a human adjuster is on the call.** The 0:05 line, roughly: "I have the claim, and I have an adjuster on this call with me." This answers the "you should not automate this" objection before a judge forms it, per spec section 2A.
4. **You do not exercise judgement.** You quote records and compute. You do not deny coverage, interpret policy language, or decide liability.
5. **Greetings carry no name**, including on a resumed call where the caller is known.

- [ ] **Step 5: Implement the verbatim-speech path**

On approval, the tool implementation returns the operator's final text held in console state, **not** the model's original argument. This is legitimate and it is where "Approve with edits" lives: TrueForge approves the tool call, and what the tool does when approved is our code. It preserves the invariant, because there is still no path from model text generation to TTS for a binding utterance. Record both `wanted` and `said` so the console can show the diff.

- [ ] **Step 6: Prove the whole loop end to end**

Run a turn that reaches the gate, deny it with a reason, confirm the agent redrafts and the gate fires again, then allow and confirm the returned string is the operator's text. Paste the event sequence into the PR.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/gated.ts agent.json test/gated.test.ts
git commit -m "Gate the utterance and scope pre-authorisation to approved amounts"
```

---

### Task 6: Session suspend and resume

**Files:**
- Create: `src/session/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Produces: `checkpoint(phone, state)`, `resume(phone, withinMs)` where state is `{ computed_results, pending_draft, transcript_index, gate_state, run_ids }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/store.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpoint, resume } from '../src/session/store.ts';

test('a resumed call carries the same run ids, proving nothing was recomputed', async () => {
  await checkpoint('+14155550142', { run_ids: ['run-7c21'], pending_draft: 'draft', transcript_index: 12 });
  const s = await resume('+14155550142', 10 * 60_000);
  assert.deepEqual(s?.run_ids, ['run-7c21']);
  assert.equal(s?.pending_draft, 'draft');
});

test('a checkpoint older than the window does not resume', async () => {
  await checkpoint('+14155550199', { run_ids: [] }, Date.now() - 11 * 60_000);
  assert.equal(await resume('+14155550199', 10 * 60_000), null);
});
```

- [ ] **Step 2: Run it and confirm it fails**

- [ ] **Step 3: Implement as a JSON file keyed by phone number.** A dictionary written to disk, not a state machine. Roughly twenty minutes.

- [ ] **Step 4: Run the tests and confirm they pass**

- [ ] **Step 5: Wire into the endpoint.** On an inbound call whose caller matches a live checkpoint, open with a resume line naming the open question rather than a greeting. Per the standing rule, that line carries no name.

- [ ] **Step 6: Commit**

```bash
git add src/session test/store.test.ts
git commit -m "Persist and resume a call by caller number"
```

---

### Task 7: Operator console

The Best UI entry. Three panes, one HTML page, SSE, no framework.

**Files:**
- Create: `src/console/index.html`, `src/console/console.ts`, `src/console/events.ts`

- [ ] **Step 1: Serve the page and an `/events` SSE stream** from the Task 1 server.

- [ ] **Step 2: Build the Lanes pane.** Five rows: tool name, elapsed ms, result summary. Underneath, the counter `3.4s parallel versus 11.1s serial`, both values from `runLanes`.

- [ ] **Step 3: Build the Computed pane.** Every number the agent holds, each tagged `computed` with its `run_id` or `record` with its fixture and field. **Nothing untagged.** Render an untagged value in red so the failure is visible on camera rather than silent.

- [ ] **Step 4: Build the Gate pane.** Draft utterance in a text box, breakdown and source records beside it, three buttons: Approve, Approve with edits, Send back to recompute. Above them, **a counter showing how long the caller has been on hold.**

- [ ] **Step 5: Type and colour.** Per the standing type rule, Geist and Geist Mono via `@fontsource`, never a bare CDN link and never `system-ui`. Figures in Geist Mono so digits align. Set `font-optical-sizing: auto`.

- [ ] **Step 6: Verify the whole thing on a real call** and commit.

```bash
git add src/console
git commit -m "Add operator console with lanes, provenance and the gate"
```

---

### Task 8: Honest counters from the run log

**Files:**
- Create: `src/console/counters.ts`
- Test: `test/counters.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/counters.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { tally } from '../src/console/counters.ts';

test('counts spoken numbers by provenance, never claiming all are computed', () => {
  const t = tally([
    { value: 21340.00, from: 'computed' }, { value: 1000.00, from: 'record' },
  ]);
  assert.deepEqual(t, { spoken: 2, computed: 1, record: 1, recalled: 0 });
});

test('a number with no provenance counts as recalled and breaks the invariant', () => {
  const t = tally([{ value: 99, from: undefined }]);
  assert.equal(t.recalled, 1);
});
```

- [ ] **Step 2: Run it, confirm it fails, implement, confirm it passes**

- [ ] **Step 3: Render both counters and hold them on screen at the end of the call**

```
numbers spoken 14   |   computed 8   |   traced to record 6   |   recalled 0
binding utterances 2   |   approved 2   |   spoken unapproved 0
```

**Generate these from the run log, never hard-code them.** The invariant is not "everything is computed", which would be a lie since a deductible is a lookup. It is that nothing is recalled, and a judge who sees a hard-coded 14 will assume the rest is staged too.

- [ ] **Step 4: Commit**

```bash
git add src/console/counters.ts test/counters.test.ts
git commit -m "Generate provenance counters from the run log"
```

---

### Task 9: README and the Qodo evidence section

Required of every submission. Not optional cleanup.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write the README**: what it is, how to run it, how to test it. Nothing else.

- [ ] **Step 2: Add the required section, with this exact heading**

```markdown
## Qodo Code Review Evidence
```

It must carry a link to at least one representative merged PR containing meaningful hackathon code, one or two sentences on what Qodo surfaced and what was changed or intentionally dismissed, and a PR history showing the completed review, the decisions, and a follow-up review against the final code. **The public PR link is the required evidence; a screenshot cannot replace it.**

- [ ] **Step 3: Disclose AI assistance.** Rule 12 requires it.

- [ ] **Step 4: State plainly what pre-existed.** The Telnyx account and the voice configuration come from an earlier personal project. All code in this repository was written during the hackathon week, and the commit history starting 2026-08-28 shows it. Saying this unprompted turns a possible smell into a code-quality point.

- [ ] **Step 5: Commit and merge**

---

## Ordering under time pressure

| Slot | Tasks |
|---|---|
| Friday night | Task 1 (telephony), Task 2 (fixtures), Task 3 (settlement) |
| Saturday 11:00 to 12:00 | Task 4 (MCP, lanes) |
| Saturday 12:00 to 13:15 | Task 5 (the gate), Task 7 (console) |
| Saturday 13:15 to 13:45 | Task 6 (resume), Task 8 (counters) |
| Saturday 13:45 to 14:15 | Record three takes on site |
| Saturday evening, Sunday am | Task 9, Qodo follow-ups, submit |

If Task 1 is not green by 12:00 Saturday, fall back to a browser softphone and say so in the video. Drop in the order given in spec section 1: the second gate first, then multiple MCP servers, then barge-in, then voice quality, then the live audit screen. **Never drop the gate, the provenance tags, or the reconciliation.**

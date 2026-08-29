# Hold the Line: call quality, live console, gate correctness

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Steps use checkbox (`- [ ]`) syntax.

**Goal:** A real phone call sounds like a person, drives the operator console live, and
cannot speak a binding commitment without a human click.

**Architecture:** Three independent workstreams on separate branches. A speaks into the
Telnyx text path, B opens a channel from the MCP tool process to the telephony
broadcaster, C makes the TrueForge approval gate actually block speech.

**Tech Stack:** Node 22 type-stripping, no build step, `node --test`, TrueForge harness,
Telnyx AI Assistant, MCP SDK, plain DOM console.

**Spec:** this file. Evidence below was captured live on 2026-08-29.

## Evidence (captured, not assumed)

One real turn through `POST /v1/chat/completions`, 88 content chunks, reassembled:

```
I can look into that for you. One moment while I check.Checking on that now.Bear with me.I've got your file here. I can see the 2021 Subaru Outback. Let me run the numbers.One moment while I check.Give me just a second.I've run the figures. Your claim is being handled as a total loss, and the net settlement works out to $13,481.12.
```

1. `check.Checking`, `me.I've`, `numbers.One` — no separator between TrueForge messages.
   Each tool round is its own `model.message`, and `harness-bridge.ts` concatenates their
   deltas with nothing between. TTS reads a period with no following space badly. This is
   the "sentences and then dot" the operator hears.
2. Three fillers stack back to back because the agent emits one before every tool call and
   the tool calls are consecutive.
3. `$13,481.12` reaches TTS unnormalised. A decimal point is commonly read "dot one two".
4. `[gate] approval required: [{"id":"call_pfUmambJfpISErJ9rcIYMHui","source_event_id":"01m1..."}]`
   The real TrueForge approval event carries **only** `id` and `source_event_id`. It has no
   `name` and no `arguments`. `server.ts` reads `arguments.tool_name` and `input.utterance`,
   so every live gate event broadcasts `tool: "unknown"` with no draft utterance.
5. The same turn still spoke the settlement figure while that approval was pending.
   `harness-bridge.ts` `continue`s past the approval event and keeps yielding text.
6. Local `/sse` produced 0 bytes in 25s on a live call. `broadcast()` is only reachable from
   call-started, session-resumed and gate-opened. `lane`, `lanes_summary`, `number` and
   `hold` are produced nowhere in the live path; they exist only in `recordedNorthvaneCall()`.
7. The MCP tool process (port 8792) has no channel of any kind back to telephony (8791).

## Global Constraints

- Node >= 22.6.0. No build step: browser modules are type-stripped on the way out, so no
  enums, no namespaces, no parameter properties (`test/loadable.test.ts` enforces this).
- No new runtime dependencies without justifying the package in the PR body.
- `npm test` (130 tests today) and `npm run typecheck` must both be green before any PR.
- No em dashes and no en dashes in code, comments, commits, PR bodies, docs.
- Banned words in artifacts: delve, leverage, seamless, robust, comprehensive, journey,
  dive into, "it's important to note". No emoji headers, no marketing voice.
- No AI attribution: no Co-Authored-By, no "Generated with" footer, in any commit or PR.
- Comments only where the code cannot say it. Match the density already in these files.
- Secrets never leave `.env.local`. Never print `TELEPHONY_SHARED_SECRET`.
- Never auto-approve a gated tool. That is the whole product.

## Workstreams

### A: the call sounds like a person
Branch `fix/call-quality`. Owns `src/telephony/harness-bridge.ts`,
`src/telephony/chat-endpoint.ts`, `agent.json`.
Fix message-boundary joining, filler stacking, and TTS number normalisation.

### B: the console shows a live call
Branch `feat/live-console-events`. Owns `src/mcp/server.ts`, `src/telephony/server.ts`,
`src/console/events.ts`.
Open a reporting channel from the MCP process to the telephony broadcaster, emit
`lane` / `lanes_summary` / `number` / `hold` from real tool calls, and replay a per-call
buffer to a client that connects mid-call.

### C: the gate actually holds
Branch `fix/approval-gate`. Owns `src/trueforge/client.ts`, `src/trueforge/types.ts`,
`src/telephony/harness-bridge.ts` (approval path only), `src/mcp/gated.ts`.
Make an approval-required event stop speech, carry the real tool name and draft utterance,
and resume correctly on approve or send-back.

A and C both touch `harness-bridge.ts`. C rebases onto A.

# hold-the-line

A voice agent that puts the caller on hold and asks a human before it says anything binding.

Built on [TrueForge](https://github.com/truefoundry/trueforge) for the Agent Harness Hackathon.

## What it is

Northvane Mutual is a fictional auto insurer. A caller whose car has been totaled calls the
claims line. Telnyx AI Assistant owns the voice side (speech to text, text to speech, turn
taking) and forwards each turn to a TrueForge harness session running here. The agent pulls
the real records, computes the settlement in a sandboxed script, and puts the caller on hold
while a human operator approves the exact sentence that commits the company to a dollar
figure. The operator can edit that sentence, or reject it and send the agent back to
recompute with different terms.

The project is built around one rule: **the gate sits on the utterance, not on the tool
call.** The agent cannot speak a binding sentence directly. To say one it must call
`offer.state_settlement`, whose argument is the sentence itself, and TrueForge holds the turn
open with `require_approval_for_tools` until a human approves, edits, or rejects it. There is
no code path from the model's own text generation to the caller's ear for a binding
utterance.

A dropped call also resumes as itself, not as a reset. State checkpoints to disk keyed on the
caller's phone number, so a callback within ten minutes picks up mid-thought: the same
`run_ids` come back (proof nothing was recomputed), and a gate draft the operator was
mid-edit on is still there.

Every number the agent speaks is either computed in the sandbox or traced to a fixture
field, never recalled from the model. All customer data (Northvane Mutual, Daniel Ortiz,
Cascade Auto Finance) is fictional. See
`docs/superpowers/specs/2026-08-28-northvane-scenario.md` for the full scenario and
`docs/superpowers/plans/2026-08-28-hold-the-line.md` for the build plan.

## How to run it

Requires Node >=22.6 and a running [TrueForge](https://github.com/truefoundry/trueforge)
instance on `:8790`.

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the Telnyx, TrueForge and Daytona values.
   Generate `TELEPHONY_SHARED_SECRET` with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   Never commit `.env.local`.
3. Register the agent and the MCP server with TrueForge:
   ```bash
   curl -s -X POST http://localhost:8790/api/v1/agents -H 'content-type: application/json' -d @agent.json
   curl -s -X POST http://localhost:8790/api/v1/settings/mcp-servers -H 'content-type: application/json' \
     -d '{"name":"northvane","url":"http://localhost:8792/mcp"}'
   ```
4. Start the telephony server: `node --env-file=.env.local --experimental-strip-types src/telephony/server.ts`
   (listens on `:8791`, health check at `/health`).
5. Expose it and point Telnyx at it:
   ```bash
   cloudflared tunnel --url http://localhost:8791
   node --env-file=.env.local scripts/telnyx-assistant.mts --create
   ```
6. Call the number the script prints.
7. Open the operator console at `http://localhost:8791/console`. It connects live by
   default. `?demo` replays the recorded call instead, `?speed=20` replays it faster and
   `?until=71000` freezes it at a point in call time.

`./scripts/start.sh` does steps 3 to 5 for you and is the shorter path.

The claim tools run in their own process on `:8792`, because TrueForge takes MCP servers by
remote URL only. They report what they did to telephony over an authenticated POST to
`/ingest`, which is what fills the console's panes during a live call. `start.sh` generates
`CONSOLE_INGEST_SECRET` and hands it to both processes; set it in `.env.local` only if you
start the two by hand, and set the same value for both. Without it the tools stay quiet and
the console shows the call and the gate but no lanes and no figures.

Session checkpoints write to `data/sessions.json`, created on first checkpoint. Override the
path with `SESSION_STORE_PATH` if you want it elsewhere, which is also how the tests keep
their own files out of the way of a real one.

## How to test it

```bash
npm run typecheck   # tsc -p tsconfig.json --noEmit
npm test            # node --test --experimental-strip-types test/*.test.ts
```

No mocking of the Telnyx API and no live phone calls in tests, ever. The settlement tests
reconcile every figure by hand against the spec so a wrong digit fails loudly; the session
store tests check that a resumed call carries back identical `run_ids` and that a mid-edit
gate draft survives a drop.

## Qodo Code Review Evidence

Every PR carrying code went through the same cycle before merging to `main`: `/describe`, a
review pass, `/improve`, at least one `/ask`, then `/agentic_review` as a follow-up pass
against the fix commit. Two examples with real findings and real consequences:

**[PR #1, Add TrueForge client and the approval resume loop](https://github.com/karimbabasf/hold-the-line/pull/1)**
(merged). Qodo's first pass flagged a High/Reliability bug:
[`request()` left `AbortSignal.timeout(30s)` attached to the whole response body](https://github.com/karimbabasf/hold-the-line/pull/1#discussion_r3885741181),
so a long SSE turn was killed at 30 seconds no matter how the call was going, a caller left
on hold mid-thought.
[Fixed](https://github.com/karimbabasf/hold-the-line/pull/1#discussion_r3885839020): the
timeout now covers connecting only and clears once headers arrive, the caller's own abort
signal still cancels a hangup, and a test streams past 30s and checks both events survive.
The `/agentic_review` follow-up
([invoked here](https://github.com/karimbabasf/hold-the-line/pull/1#issuecomment-5460851421))
against that fix then caught what the narrower timeout had opened up:
[a JSON or error body read now has no deadline at all](https://github.com/karimbabasf/hold-the-line/pull/1#discussion_r3885844900).
That finding posted after merge and is still open, disclosed here rather than dropped. A
separate High on the same PR, "Build emits no artifacts" against `tsconfig.json`'s `noEmit`,
was addressed a different way than Qodo's suggested diff, and the bot's own review marks it
**Dismissed** rather than resolved: `noEmit` is deliberate, the source runs directly under
`--experimental-strip-types` and nothing is compiled.

**[PR #4, Add the Northvane fixtures and the settlement engine](https://github.com/karimbabasf/hold-the-line/pull/4)**
(merged). Qodo caught that
[`optionsCents` and `feesCents`, both sums of several fixture fields, were tagged `from: 'record'`](https://github.com/karimbabasf/hold-the-line/pull/4#discussion_r3885858122)
instead of `computed`. Not cosmetic: the on-screen provenance counters are generated from
`SettleLine.from`, so the mistag would have reported arithmetic as a direct record lookup,
against the one claim the whole project rests on.
[Fixed](https://github.com/karimbabasf/hold-the-line/pull/4#discussion_r3885880172): both are
`computed` now with the arithmetic spelled out in `detail`, and the record count dropped from
6 to 2 as a result, which is exactly why that counter is generated from the run log instead
of hard-coded. The `/agentic_review` follow-up re-ran against the fix commit, and Qodo's own
review comment on the PR now shows all three findings on it marked Resolved.

Both threads carry the full cycle in order in the PR conversation, not just the diff: the
bot's review, the fix replies, and the follow-up review against the final commit.

## AI assistance and prior work

This repository was built with Claude (Anthropic's Claude Code) directing the implementation
under human review, using the plan and spec in `docs/superpowers/`. Every substantive change
went through a GitHub pull request reviewed by Qodo before merging, per the evidence above.

Two things pre-date the hackathon: the Telnyx account and the voice assistant configuration
it registers against come from an earlier personal project of the author's. Everything else,
all code in this repository, was written during the hackathon week. The commit history
starting 2026-08-28 shows it.

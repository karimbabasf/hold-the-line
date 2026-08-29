import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBridge } from '../src/telephony/harness-bridge.ts';
import type { TrueForgeClient } from '../src/trueforge/client.ts';
import {
  isApprovalRequired,
  resolveGate,
  type ApprovalDecision,
  type ModelMessageEvent,
  type ResolvedGate,
  type TurnEvent,
  type TurnInputItem,
} from '../src/trueforge/types.ts';

/**
 * The approval gate, tested against the shapes a live TrueForge actually
 * sends. Every fixture in this file was captured from
 * `http://localhost:8790` on 2026-08-29, not written from the type
 * definitions, because the type definitions were what was wrong.
 *
 * The load-bearing test is "a settlement figure is never spoken before an
 * operator authorises it". A green run of that test is the claim this whole
 * product makes.
 */

const CALLER = '+15550001111';
const NET = 13481.12;

/** The approval event exactly as the live harness sends it. No `name`, no
 *  `arguments`, only `id` and `source_event_id`. */
const LIVE_APPROVAL = {
  type: 'tool.approval_required',
  id: '01m17552gpn3knxfsp9my84cxf',
  created_at: '2026-08-29T16:20:27.286Z',
  thread_id: 'main',
  tool_calls: [
    {
      id: 'call_nvylAplh9j59WZXXztViO60N',
      source_event_id: '01m175518rsa4prf8dvrrwrtj1',
    },
  ],
};

/** The persisted `model.message` that `source_event_id` points at. This is
 *  where the real tool name and the draft utterance live. `arguments` is a
 *  JSON *string*, and `function.name` is always the literal `call_tool`. */
const LIVE_SOURCE_EVENT: ModelMessageEvent = {
  type: 'model.message',
  id: '01m175518rsa4prf8dvrrwrtj1',
  content: 'Checking on that now.',
  tool_calls: [
    {
      id: 'call_nvylAplh9j59WZXXztViO60N',
      type: 'function',
      function: {
        name: 'call_tool',
        arguments: JSON.stringify({
          mcp_server: 'northvane',
          tool_name: 'offer.state_settlement',
          input: {
            claim_id: 'CLM-40218',
            utterance:
              'We can settle this claim for $13,481.12 based on the total loss calculation.',
            authorised_amounts: [NET],
          },
        }),
      },
    },
  ],
};

/** A `settlement.calculate` response, trimmed to the field that makes an
 *  amount binding. */
const SETTLEMENT_RESPONSE = {
  type: 'tool.response',
  id: 'ev-settle',
  tool_call_id: 'call_settle',
  content: JSON.stringify({
    is_total_loss: true,
    acv: 21340,
    payoff: 8764.12,
    net: NET,
    run_id: 'run-mtel71m301',
  }),
};

function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'htl-gate-'));
  process.env.SESSION_STORE_PATH = join(dir, 'sessions.json');
  return dir;
}

interface ForgeScript {
  /** Events for the first turn, then for each resumed turn in order. */
  turns: TurnEvent[][];
}

/**
 * A harness stub that replays captured event sequences and records the
 * resume input it was sent.
 */
function stubForge(script: ForgeScript) {
  const inputs: TurnInputItem[][] = [];
  let turn = 0;
  const client = {
    async createSession(): Promise<string> {
      return 'sess-1';
    },
    async *streamTurn(
      _sessionId: string,
      input: TurnInputItem[],
    ): AsyncGenerator<TurnEvent> {
      inputs.push(input);
      const events = script.turns[turn] ?? [];
      turn += 1;
      for (const e of events) yield e;
    },
    async findEvent(
      _sessionId: string,
      eventId: string,
    ): Promise<ModelMessageEvent | undefined> {
      return eventId === LIVE_SOURCE_EVENT.id ? LIVE_SOURCE_EVENT : undefined;
    },
  };
  return { client: client as unknown as TrueForgeClient, inputs };
}

const delta = (id: string, content: string): TurnEvent =>
  ({ type: 'model.message.delta', id, content }) as unknown as TurnEvent;
const message = (id: string): TurnEvent =>
  ({ type: 'model.message', id, thread_id: 'main' }) as unknown as TurnEvent;
const done = (): TurnEvent =>
  ({ type: 'turn.done', id: 'ev-done', state: { status: 'done' } }) as unknown as TurnEvent;

async function speak(
  gen: AsyncGenerator<{ type: string; text: string }>,
): Promise<string> {
  let said = '';
  for await (const d of gen) said += d.text;
  return said;
}

async function withStore<T>(fn: () => Promise<T>): Promise<T> {
  const dir = tempStore();
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SESSION_STORE_PATH;
  }
}

test('the live approval event shape is recognised', () => {
  assert.equal(
    isApprovalRequired(LIVE_APPROVAL as unknown as TurnEvent),
    true,
    'the event captured from the live harness must narrow',
  );
});

test('the gate carries the real tool name and the draft utterance', () => {
  const gate = resolveGate(
    LIVE_APPROVAL.tool_calls[0]!,
    LIVE_APPROVAL.thread_id,
    LIVE_SOURCE_EVENT,
  );
  assert.equal(gate.tool, 'offer.state_settlement');
  assert.equal(gate.claim_id, 'CLM-40218');
  assert.match(gate.utterance ?? '', /13,481\.12/);
  assert.deepEqual(gate.authorised_amounts, [NET]);
  assert.equal(gate.tool_call_id, 'call_nvylAplh9j59WZXXztViO60N');
  assert.equal(gate.thread_id, 'main');
});

test('a gate whose source event is missing resolves to unknown, never to a guess', () => {
  const gate = resolveGate(LIVE_APPROVAL.tool_calls[0]!, 'main', undefined);
  assert.equal(gate.tool, 'unknown');
  assert.equal(gate.utterance, undefined);
});

test('the console never sees the call_tool envelope name', () => {
  const gate = resolveGate(
    LIVE_APPROVAL.tool_calls[0]!,
    'main',
    LIVE_SOURCE_EVENT,
  );
  assert.notEqual(gate.tool, 'call_tool');
});

test('a settlement figure is never spoken before an operator authorises it', async () => {
  // The captured failure: in 4 of 8 live runs the agent stated the net
  // settlement as ordinary prose. Twice it did so in a turn that then parked
  // on an approval, and twice in a turn that never opened a gate at all.
  // Neither is speakable without a human click.
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        [
          message('m1'),
          delta('m1', 'One moment while I check.'),
          SETTLEMENT_RESPONSE as unknown as TurnEvent,
          message('m2'),
          delta('m2', 'The settlement works out to $13,481.12 after the payoff.'),
          done(),
        ],
      ],
    });
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });
    const said = await speak(bridge.runTurn('what is the payout', CALLER));

    assert.doesNotMatch(
      said,
      /13[,.]481/,
      'an unauthorised settlement figure reached the caller',
    );
    assert.match(said, /One moment while I check/, 'the filler must still be spoken');
  });
});

test('a figure the agent may quote from the record is still spoken', async () => {
  // The tripwire has to be narrow. agent.json permits quoting a record, so
  // blocking every number would break the call.
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        [
          message('m1'),
          SETTLEMENT_RESPONSE as unknown as TurnEvent,
          message('m2'),
          delta('m2', 'Your collision deductible is $1,000.'),
          done(),
        ],
      ],
    });
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });
    const said = await speak(bridge.runTurn('what is my deductible', CALLER));
    assert.match(said, /\$1,000/);
  });
});

test('a turn that parks on an approval speaks none of that turn s pending text', async () => {
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        [
          message('m1'),
          delta('m1', 'Bear with me.'),
          SETTLEMENT_RESPONSE as unknown as TurnEvent,
          message(LIVE_SOURCE_EVENT.id),
          delta(
            LIVE_SOURCE_EVENT.id,
            'I can confirm the net settlement works out to $13,481.12.',
          ),
          LIVE_APPROVAL as unknown as TurnEvent,
          done(),
        ],
      ],
    });
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });
    const said = await speak(bridge.runTurn('is it totaled', CALLER));

    assert.doesNotMatch(said, /13[,.]481/, 'the gated message reached the caller');
    assert.match(said, /Bear with me/, 'the earlier filler should still be spoken');
  });
});

test('text streamed after an approval is pending never reaches the caller', async () => {
  // The harness ends the turn at the approval today. This proves the bridge
  // does not depend on that: even a harness that kept streaming cannot get a
  // word past a pending gate.
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        [
          message('m1'),
          LIVE_APPROVAL as unknown as TurnEvent,
          message('m2'),
          delta('m2', 'And we will wire the funds today.'),
          done(),
        ],
      ],
    });
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });
    const said = await speak(bridge.runTurn('is it totaled', CALLER));
    assert.equal(said, '', 'speech continued past a pending approval');
  });
});

test('an approval that never resolves speaks nothing and is never auto-approved', async () => {
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        [
          message(LIVE_SOURCE_EVENT.id),
          delta(LIVE_SOURCE_EVENT.id, 'We can settle for $13,481.12.'),
          LIVE_APPROVAL as unknown as TurnEvent,
          done(),
        ],
        [message('m9'), delta('m9', 'SHOULD NEVER BE REACHED'), done()],
      ],
    });
    let asked = 0;
    const bridge = createBridge({
      forge: forge.client,
      agentName: 'northvane',
      // An operator who walks away. No decision, ever.
      awaitApproval: async (): Promise<ApprovalDecision | null> => {
        asked += 1;
        return null;
      },
    });
    const said = await speak(bridge.runTurn('is it totaled', CALLER));

    assert.equal(said, '');
    assert.equal(asked, 1, 'the operator must actually be asked');
    assert.equal(
      forge.inputs.length,
      1,
      'no decision must never turn into a resume',
    );
  });
});

test('an allow resumes the same thread and speaks the approved wording', async () => {
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        [
          message(LIVE_SOURCE_EVENT.id),
          delta(LIVE_SOURCE_EVENT.id, 'Give me just a second.'),
          LIVE_APPROVAL as unknown as TurnEvent,
          done(),
        ],
        [
          message('m2'),
          delta('m2', 'We can settle this claim for $13,481.12.'),
          done(),
        ],
      ],
    });
    const seen: ResolvedGate[] = [];
    const bridge = createBridge({
      forge: forge.client,
      agentName: 'northvane',
      onApprovalRequired: (gate) => seen.push(gate),
      awaitApproval: async () => ({ status: 'allow' }),
    });
    const said = await speak(bridge.runTurn('is it totaled', CALLER));

    // The figure is speakable now, and only now, because the operator
    // approved an offer that authorised it.
    assert.match(said, /\$13,481\.12/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.tool, 'offer.state_settlement');

    const resume = forge.inputs[1]?.[0] as {
      type: string;
      thread_id?: string;
      tool_call_id?: string;
      approval?: ApprovalDecision;
    };
    assert.equal(resume.type, 'user.tool_approval');
    assert.equal(resume.thread_id, 'main');
    assert.equal(resume.tool_call_id, 'call_nvylAplh9j59WZXXztViO60N');
    assert.deepEqual(resume.approval, { status: 'allow' });
  });
});

test('a send back resumes with the reason and still withholds the figure', async () => {
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        [
          message(LIVE_SOURCE_EVENT.id),
          delta(LIVE_SOURCE_EVENT.id, 'Give me just a second.'),
          LIVE_APPROVAL as unknown as TurnEvent,
          done(),
        ],
        [
          message('m2'),
          SETTLEMENT_RESPONSE as unknown as TurnEvent,
          message('m3'),
          delta('m3', 'The figure is $13,481.12 before consent.'),
          done(),
        ],
      ],
    });
    const bridge = createBridge({
      forge: forge.client,
      agentName: 'northvane',
      awaitApproval: async () => ({
        status: 'deny',
        reason: 'Mention the lienholder consent step first.',
      }),
    });
    const said = await speak(bridge.runTurn('is it totaled', CALLER));

    const resume = forge.inputs[1]?.[0] as { approval?: ApprovalDecision };
    assert.deepEqual(resume.approval, {
      status: 'deny',
      reason: 'Mention the lienholder consent step first.',
    });
    // A denial authorises nothing, so the redraft still cannot say the money.
    assert.doesNotMatch(
      said,
      /13[,.]481/,
      'a denied offer must not leave the figure speakable',
    );
  });
});

test('a gate round never recurses without bound', async () => {
  await withStore(async () => {
    // A harness that parks on every resume. Without a cap this recurses until
    // the stack or the call dies.
    const parked = [
      message(LIVE_SOURCE_EVENT.id),
      LIVE_APPROVAL as unknown as TurnEvent,
      done(),
    ];
    const forge = stubForge({
      turns: [parked, parked, parked, parked, parked, parked, parked, parked],
    });
    let asked = 0;
    const bridge = createBridge({
      forge: forge.client,
      agentName: 'northvane',
      awaitApproval: async () => {
        asked += 1;
        return { status: 'deny', reason: 'again' };
      },
    });
    await speak(bridge.runTurn('is it totaled', CALLER));
    assert.ok(asked >= 1, 'the operator should be asked at least once');
    assert.ok(asked <= 6, `unbounded gate recursion: asked ${asked} times`);
  });
});

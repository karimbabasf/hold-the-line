import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBridge } from '../src/telephony/harness-bridge.ts';
import { speakNumbers } from '../src/telephony/speech.ts';
import { TrueForgeClient } from '../src/trueforge/client.ts';
import {
  isApprovalRequired,
  isQuestionRequired,
  resolveGate,
  resolveQuestion,
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
  /** Persisted events `findEvent` can return, beyond the gate's own. */
  sourceEvents?: ModelMessageEvent[];
  /** Behave like the real harness: refuse a bare message while parked. */
  refuseMessageWhileParked?: boolean;
}

/**
 * A harness stub that replays captured event sequences and records the
 * resume input it was sent.
 */
function stubForge(script: ForgeScript) {
  const inputs: TurnInputItem[][] = [];
  let turn = 0;
  let parked = false;
  const known = [LIVE_SOURCE_EVENT, ...(script.sourceEvents ?? [])];
  const client = {
    async createSession(): Promise<string> {
      return 'sess-1';
    },
    async *streamTurn(
      _sessionId: string,
      input: TurnInputItem[],
    ): AsyncGenerator<TurnEvent> {
      if (
        script.refuseMessageWhileParked &&
        parked &&
        input.some((i) => i.type === 'user.message')
      ) {
        // The real 422, verbatim.
        throw new Error(
          'thread main: user message cannot be sent while approvals or questions are pending',
        );
      }
      inputs.push(input);
      const events = script.turns[turn] ?? [];
      turn += 1;
      parked = events.some((e) => e.type === 'tool.response_required');
      for (const e of events) yield e;
    },
    async findEvent(
      _sessionId: string,
      eventId: string,
    ): Promise<ModelMessageEvent | undefined> {
      return known.find((e) => e.id === eventId);
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

/** Reads "13,481 dollars and 12 cents" back as 13481.12, in cents. */
function centsSpoken(text: string): number[] {
  const out: number[] = [];
  const re = /(\d[\d,]*)\s+dollars(?:\s+and\s+(\d+)\s+cents?)?/g;
  for (const m of text.matchAll(re)) {
    const dollars = Number((m[1] as string).replace(/,/g, ''));
    // "and 5 cents" is five cents, not fifty. A single digit is a count of
    // cents, never a tenths place.
    const cents = m[2] === undefined ? 0 : Number(m[2]);
    out.push(Math.round(dollars * 100) + cents);
  }
  return out;
}

/**
 * The shaper is allowed to change the words of an approved sentence and is
 * never allowed to change the amount.
 *
 * `offer.state_settlement` returns wording an operator signed off and the
 * agent says it back word for word, but it passes through `speakNumbers()`
 * on the way to the caller because raw currency reaches TTS as "dot one
 * two". So the string that leaves is not the string that was approved, by
 * design. What has to hold is that the money survives: a shaper that
 * rounded, reformatted or dropped a digit would put an amount in the
 * caller's ear that no operator ever saw, which is the same class of
 * failure as speaking an unapproved figure. Only a comment stood between us
 * and that.
 */
test('the shaper never changes an approved amount', () => {
  // Read as cents rather than as a digit string, because the shaper is meant
  // to drop a leading zero ("$9,000.05" is spoken "5 cents", not "05 cents")
  // and to drop an empty fraction ("$450.00" is spoken "450 dollars"). Those
  // change the characters and not the money. Rounding, reformatting or
  // losing a digit would change the money, and that is what this catches.
  const cases: Array<[string, number[]]> = [
    // The exact utterances captured from live gates on 2026-08-29.
    ['We can settle this claim for $13,481.12.', [1348112]],
    [
      'We can settle your total loss at $13,481.12, subject to lienholder consent.',
      [1348112],
    ],
    [
      'We can offer you $13,481.12 on this total loss claim, based on the current valuation and payoff.',
      [1348112],
    ],
    // Amounts that go wrong if anyone ever reaches for toFixed or Math.round.
    ['That comes to $9,000.05 exactly.', [900005]],
    ['The payoff is $8,764.10 through the second.', [876410]],
    ['Storage has reached $450.00 so far.', [45000]],
    ['Your deductible is $1,000.', [100000]],
    ['The lien principal is $8,699.72.', [869972]],
    // Two figures in one approved sentence, in order.
    ['That is $21,340.00 less $8,764.12.', [2134000, 876412]],
  ];

  for (const [approved, wantCents] of cases) {
    const spoken = speakNumbers(approved);
    assert.deepEqual(
      centsSpoken(spoken),
      wantCents,
      `the amount changed for ${JSON.stringify(approved)}: got ${JSON.stringify(spoken)}`,
    );
    // The dollars are also copied through as written rather than respelled,
    // so an operator reading the console sees the grouping the caller hears.
    for (const m of approved.matchAll(/\$(\d{1,3}(?:,\d{3})+|\d+)/g)) {
      assert.ok(
        spoken.includes(m[1] as string),
        `the dollar grouping "${m[1]}" was rewritten in ${JSON.stringify(spoken)}`,
      );
    }
  }
});

test('an approved amount survives the shaper through a live gate round', async () => {
  // The same property end to end rather than on the shaper alone: what an
  // operator approved is what a caller hears, digit for digit.
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        [
          message(LIVE_SOURCE_EVENT.id),
          LIVE_APPROVAL as unknown as TurnEvent,
          done(),
        ],
        [
          message('m2'),
          // The agent saying the approved wording back, word for word.
          delta('m2', 'We can settle this claim for $13,481.12.'),
          done(),
        ],
      ],
    });
    const bridge = createBridge({
      forge: forge.client,
      agentName: 'northvane',
      awaitApproval: async () => ({ status: 'allow' }),
    });
    const said = await speak(bridge.runTurn('is it totaled', CALLER));

    assert.equal(
      (said.match(/\d/g) ?? []).join(''),
      '1348112',
      `the approved amount changed on its way to the caller: ${JSON.stringify(said)}`,
    );
  });
});

/**
 * The parked question, captured live on 2026-08-29. Same shape as an
 * approval: `{id, source_event_id}` and nothing else.
 */
const LIVE_QUESTION = {
  type: 'tool.response_required',
  id: '01m1778vb9kn187m3kha9qqx2m',
  created_at: '2026-08-29T16:57:28.169Z',
  thread_id: 'main',
  tool_calls: [
    {
      id: 'call_vqgE8dQFc9PqamUyPtVHMMtf',
      source_event_id: 'ev-question-src',
    },
  ],
};

/** Its source event. The tool is `ask_user_question`, singular, and its
 *  arguments are `{question, options}` rather than a `call_tool` envelope. */
const QUESTION_SOURCE: ModelMessageEvent = {
  type: 'model.message',
  id: 'ev-question-src',
  tool_calls: [
    {
      id: 'call_vqgE8dQFc9PqamUyPtVHMMtf',
      type: 'function',
      function: {
        name: 'ask_user_question',
        arguments: JSON.stringify({
          question:
            'Please provide your claim number so I can help with your car issue.',
          options: [],
        }),
      },
    },
  ],
};

test('a parked question is recognised and its words are read off the source', () => {
  assert.equal(isQuestionRequired(LIVE_QUESTION as unknown as TurnEvent), true);
  // It must NOT look like an approval, or it would be sent an allow.
  assert.equal(isApprovalRequired(LIVE_QUESTION as unknown as TurnEvent), false);
  assert.equal(isQuestionRequired(LIVE_APPROVAL as unknown as TurnEvent), false);

  const q = resolveQuestion(
    LIVE_QUESTION.tool_calls[0]!,
    LIVE_QUESTION.thread_id,
    QUESTION_SOURCE,
  );
  assert.match(q.question, /claim number/);
  assert.equal(q.tool_call_id, 'call_vqgE8dQFc9PqamUyPtVHMMtf');
  assert.equal(q.thread_id, 'main');
  assert.deepEqual(q.options, []);
});

test('a question with no readable source asks nothing rather than guessing', () => {
  const q = resolveQuestion(LIVE_QUESTION.tool_calls[0]!, 'main', undefined);
  assert.equal(q.question, '');
});

test('a parked question is spoken to the caller', async () => {
  // Live, a turn that parks on ask_user_question streams no text at all, so
  // the caller heard silence and never learned what was being asked.
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        [message('m1'), LIVE_QUESTION as unknown as TurnEvent, done()],
      ],
      sourceEvents: [QUESTION_SOURCE],
    });
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });
    const said = await speak(bridge.runTurn('I need help with my car', CALLER));
    assert.match(said, /claim number/, 'the caller was never asked the question');
  });
});

test('the next utterance answers the question instead of hitting a 422', async () => {
  // The live failure: an ordinary message while a thread is parked returns
  // 422 "user message cannot be sent while approvals or questions are
  // pending", and the endpoint spoke its error fallback at the caller.
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        [message('m1'), LIVE_QUESTION as unknown as TurnEvent, done()],
        [message('m2'), delta('m2', 'Thanks, I have that claim now.'), done()],
      ],
      sourceEvents: [QUESTION_SOURCE],
      // A harness that behaves like the real one: a bare message while
      // parked is refused.
      refuseMessageWhileParked: true,
    });
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });

    await speak(bridge.runTurn('I need help with my car', CALLER));
    const said = await speak(bridge.runTurn('CLM-40218', CALLER));

    const answer = forge.inputs[1]?.[0] as {
      type: string;
      thread_id?: string;
      tool_call_id?: string;
      content?: string;
    };
    assert.equal(answer.type, 'user.tool_response');
    assert.equal(answer.thread_id, 'main');
    assert.equal(answer.tool_call_id, 'call_vqgE8dQFc9PqamUyPtVHMMtf');
    assert.equal(answer.content, 'CLM-40218', 'the answer must be the caller s own words');
    assert.match(said, /Thanks, I have that claim now/);
  });
});

test('a question is answered once, and the turn after it is an ordinary one', async () => {
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        [message('m1'), LIVE_QUESTION as unknown as TurnEvent, done()],
        [message('m2'), delta('m2', 'Got it.'), done()],
        [message('m3'), delta('m3', 'Still here.'), done()],
      ],
      sourceEvents: [QUESTION_SOURCE],
    });
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });
    await speak(bridge.runTurn('I need help', CALLER));
    await speak(bridge.runTurn('CLM-40218', CALLER));
    await speak(bridge.runTurn('and what is the payout', CALLER));

    assert.equal(forge.inputs[1]?.[0]?.type, 'user.tool_response');
    assert.equal(
      forge.inputs[2]?.[0]?.type,
      'user.message',
      'the question was answered twice',
    );
  });
});

test('a mixed turn input is refused before it reaches the harness', async () => {
  // The server rejects the mix with an error that does not say which item is
  // wrong, so it is caught here where the reason is still attached.
  const client = new TrueForgeClient({
    fetchImpl: async () => {
      throw new Error('the request should never have been sent');
    },
  });
  await assert.rejects(
    async () => {
      for await (const _ of client.streamTurn('sess-1', [
        { type: 'user.message', content: 'hello' },
        {
          type: 'user.tool_response',
          thread_id: 'main',
          tool_call_id: 'call_1',
          content: 'CLM-40218',
        },
      ])) {
        /* never reached */
      }
    },
    /must not mix/,
  );
});

test('a withheld sentence goes back to the agent instead of vanishing', async () => {
  // The deployed failure on 2026-08-29: the agent stated the settlement as
  // ordinary prose, the guard blocked it exactly as designed, and the turn
  // ended with the caller hearing nothing on the one beat that matters.
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        // The agent says the figure without routing it through the gate.
        [
          message('m1'),
          SETTLEMENT_RESPONSE as unknown as TurnEvent,
          message('m2'),
          delta('m2', 'The payout comes to $13,481.12 after the payoff.'),
          done(),
        ],
        // Handed back, it calls the gated tool.
        [
          message(LIVE_SOURCE_EVENT.id),
          LIVE_APPROVAL as unknown as TurnEvent,
          done(),
        ],
        // Approved, it says the figure.
        [
          message('m3'),
          delta('m3', 'We can settle this claim for $13,481.12.'),
          done(),
        ],
      ],
    });
    const bridge = createBridge({
      forge: forge.client,
      agentName: 'northvane',
      awaitApproval: async () => ({ status: 'allow' }),
    });
    const said = await speak(bridge.runTurn('what is the payout', CALLER));

    // The redraft carried the agent's own blocked sentence back to it, with
    // the instruction that fixes it.
    const cue = (forge.inputs[1]?.[0] as { content?: string }).content ?? '';
    assert.match(cue, /NOT spoken to the caller/);
    assert.match(cue, /offer\.state_settlement/);
    assert.match(cue, /The payout comes to \$13,481\.12 after the payoff\./);

    // And the turn ended with an approved offer actually spoken.
    assert.match(said, /13,481 dollars and 12 cents/);
    assert.doesNotMatch(
      said,
      /confirmed with the adjuster/,
      'it should not have needed the floor',
    );
  });
});

test('a redraft that keeps failing reaches the holding line, not silence', async () => {
  await withStore(async () => {
    const statesItAgain = [
      message('m1'),
      SETTLEMENT_RESPONSE as unknown as TurnEvent,
      message('m2'),
      delta('m2', 'The payout comes to $13,481.12.'),
      done(),
    ];
    const forge = stubForge({ turns: Array(8).fill(statesItAgain) });
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });
    const said = await speak(bridge.runTurn('what is the payout', CALLER));

    assert.doesNotMatch(said, /13[,.]481/, 'an unapproved figure reached the caller');
    assert.match(said, /confirmed with the adjuster/, 'the caller was left with dead air');
    // Bounded: the caller is not kept waiting through unlimited retries.
    assert.equal(
      forge.inputs.length,
      3,
      `redraft rounds spent: ${forge.inputs.length - 1}`,
    );
  });
});

test('the holding line commits to nothing and invents no figure', async () => {
  await withStore(async () => {
    const saysIt = [
      message('m1'),
      SETTLEMENT_RESPONSE as unknown as TurnEvent,
      message('m2'),
      delta('m2', 'We can settle at $13,481.12 today.'),
      done(),
    ];
    const forge = stubForge({ turns: [saysIt, saysIt, saysIt] });
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });
    const said = await speak(bridge.runTurn('what is the payout', CALLER));

    assert.doesNotMatch(said, /\d/, 'the holding line must carry no figure at all');
    // Nothing that sounds like a promise of an amount or an outcome.
    assert.doesNotMatch(said, /settle|offer|approved|we can|we will/i);
  });
});

test('a turn that simply said nothing gets no holding line', async () => {
  // The line is only true when something really is waiting on an adjuster.
  // An empty model turn has nothing pending, so claiming otherwise would be
  // a lie told to a caller.
  await withStore(async () => {
    const forge = stubForge({ turns: [[message('m1'), done()]] });
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });
    const said = await speak(bridge.runTurn('are you still there', CALLER));
    assert.equal(said, '');
  });
});

test('a redraft never fires for a parked question', async () => {
  // A question is not an offer. Handing it back with "call
  // offer.state_settlement" would tell the agent to commit to something it
  // was only asking about.
  await withStore(async () => {
    const questionWithAFigure: ModelMessageEvent = {
      type: 'model.message',
      id: 'ev-question-money',
      tool_calls: [
        {
          id: 'call_q_money',
          type: 'function',
          function: {
            name: 'ask_user_question',
            arguments: JSON.stringify({
              question: 'Can you confirm the $13,481.12 figure your shop quoted?',
              options: [],
            }),
          },
        },
      ],
    };
    const parkedOnMoney = {
      type: 'tool.response_required',
      id: 'ev-parked-money',
      created_at: '2026-08-29T16:57:28.169Z',
      thread_id: 'main',
      tool_calls: [{ id: 'call_q_money', source_event_id: 'ev-question-money' }],
    };
    const forge = stubForge({
      turns: [
        [
          message('m1'),
          SETTLEMENT_RESPONSE as unknown as TurnEvent,
          parkedOnMoney as unknown as TurnEvent,
          done(),
        ],
      ],
      sourceEvents: [questionWithAFigure],
    });
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });
    const said = await speak(bridge.runTurn('what is the payout', CALLER));

    assert.equal(forge.inputs.length, 1, 'a question was handed back as an offer');
    assert.doesNotMatch(said, /13[,.]481/, 'the figure reached the caller inside a question');
  });
});

test('a gate the operator sits on tells the caller why, and still never decides', async () => {
  // Live, a held gate left the HTTP stream open and silent until the far end
  // timed out. That is dead air on the beat that matters.
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        [message(LIVE_SOURCE_EVENT.id), LIVE_APPROVAL as unknown as TurnEvent, done()],
        [message('m2'), delta('m2', 'We can settle this claim for $13,481.12.'), done()],
      ],
    });
    let decided = 0;
    const bridge = createBridge({
      forge: forge.client,
      agentName: 'northvane',
      // A slow operator: longer than the quiet window, then approves.
      awaitApproval: async () => {
        await new Promise((r) => setTimeout(r, 2200));
        decided += 1;
        return { status: 'allow' };
      },
    });
    const said = await speak(bridge.runTurn('is it totaled', CALLER));

    // The caller learned why they were waiting.
    const at = said.indexOf('confirmed with the adjuster');
    assert.ok(at >= 0, `the caller heard nothing while the gate was open: ${said}`);
    // And the figure still came only after a real decision, after that line.
    const figureAt = said.search(/13,481 dollars/);
    assert.ok(figureAt > at, 'the figure was spoken before the holding line');
    assert.equal(decided, 1, 'the wait must still end in a human decision');
  });
});

test('a quick approval is not talked over by the holding line', async () => {
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        [message(LIVE_SOURCE_EVENT.id), LIVE_APPROVAL as unknown as TurnEvent, done()],
        [message('m2'), delta('m2', 'We can settle this claim for $13,481.12.'), done()],
      ],
    });
    const bridge = createBridge({
      forge: forge.client,
      agentName: 'northvane',
      awaitApproval: async () => ({ status: 'allow' }),
    });
    const said = await speak(bridge.runTurn('is it totaled', CALLER));
    assert.doesNotMatch(said, /confirmed with the adjuster/);
    assert.match(said, /13,481 dollars and 12 cents/);
  });
});

test('an approved turn does not redraft the prose that preceded the gate', async () => {
  // Prose withheld before the gate used to sit in the turn state across the
  // approval, so the approved resume redrafted a sentence that was already
  // settled: a spent model turn that could reopen a gate and tack a holding
  // line onto a turn that had just succeeded. Found by Qodo.
  await withStore(async () => {
    const forge = stubForge({
      turns: [
        [
          message('m1'),
          SETTLEMENT_RESPONSE as unknown as TurnEvent,
          // Prose with the figure, withheld, and then the gated call in the
          // same harness turn.
          message('m2'),
          delta('m2', 'The payout comes to $13,481.12.'),
          message(LIVE_SOURCE_EVENT.id),
          LIVE_APPROVAL as unknown as TurnEvent,
          done(),
        ],
        [message('m3'), delta('m3', 'We can settle this claim for $13,481.12.'), done()],
      ],
    });
    const bridge = createBridge({
      forge: forge.client,
      agentName: 'northvane',
      awaitApproval: async () => ({ status: 'allow' }),
    });
    const said = await speak(bridge.runTurn('what is the payout', CALLER));

    // One turn in, one resume out. No third, stale redraft.
    assert.equal(
      forge.inputs.length,
      2,
      `an extra redraft ran after the approval: ${JSON.stringify(forge.inputs.map((i) => i[0]?.type))}`,
    );
    assert.match(said, /13,481 dollars and 12 cents/);
    assert.doesNotMatch(
      said,
      /confirmed with the adjuster/,
      'a holding line was appended to a turn that succeeded',
    );
  });
});

test('a gate that is not about money does not promise a figure', async () => {
  // require_approval_for_tools also covers salvage.release_vehicle and
  // coverage.deny. Telling a caller their figure is being confirmed while an
  // adjuster decides whether to release their wreck is false, and the line
  // only works because it is true. Found by Qodo.
  await withStore(async () => {
    const salvageSource: ModelMessageEvent = {
      type: 'model.message',
      id: 'ev-salvage',
      tool_calls: [
        {
          id: 'call_salvage',
          type: 'function',
          function: {
            name: 'call_tool',
            arguments: JSON.stringify({
              mcp_server: 'northvane',
              tool_name: 'salvage.release_vehicle',
              input: { claim_id: 'CLM-40218', yard_id: 'YRD-118' },
            }),
          },
        },
      ],
    };
    const salvageGate = {
      type: 'tool.approval_required',
      id: 'ev-approve-salvage',
      created_at: '2026-08-29T16:20:27.286Z',
      thread_id: 'main',
      tool_calls: [{ id: 'call_salvage', source_event_id: 'ev-salvage' }],
    };
    const forge = stubForge({
      turns: [[message('ev-salvage'), salvageGate as unknown as TurnEvent, done()]],
      sourceEvents: [salvageSource],
    });
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });
    const said = await speak(bridge.runTurn('can you release the car', CALLER));

    assert.match(said, /before I can go ahead/);
    assert.doesNotMatch(said, /give you a figure/, 'a salvage gate promised a figure');
  });
});

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
    // The shaper turns "$1,000" into "1,000 dollars" for TTS. The digits are
    // what matter, and they come through untouched.
    assert.match(said, /1,000 dollars/);
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
    assert.doesNotMatch(
      said,
      /wire the funds|13[,.]481/,
      'speech continued past a pending approval',
    );
    // The caller is not left listening to nothing. The line commits to
    // nothing and states no figure.
    assert.match(said, /confirmed with the adjuster/);
    assert.doesNotMatch(said, /\d/, 'the holding line must carry no figure');
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

    assert.doesNotMatch(said, /13[,.]481/, 'an unapproved figure was spoken');
    assert.match(said, /confirmed with the adjuster/, 'the caller heard nothing at all');
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
    // approved an offer that authorised it. The shaper reads it out for TTS,
    // and every digit of the approved amount survives that.
    assert.match(said, /13,481 dollars and 12 cents/);
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

test('a flood of other callers cannot evict the caller on the line', async () => {
  // Eviction here fails open, not closed: with no binding amounts on file
  // there is nothing to compare speech against, so the figure is released.
  // The caller on the line therefore has to stay the newest entry.
  await withStore(async () => {
    // Turn one calculates the settlement. Every later turn only talks, so
    // the hold depends on the amount being REMEMBERED rather than relearned
    // from a tool response that happens to repeat.
    const calculates = [
      message('m1'),
      SETTLEMENT_RESPONSE as unknown as TurnEvent,
      message('m2'),
      delta('m2', 'Let me run the numbers.'),
      done(),
    ];
    const justTalks = [
      message('m1'),
      delta('m1', 'The settlement is $13,481.12.'),
      done(),
    ];
    const forge = stubForge({
      turns: [calculates, ...Array(700).fill(justTalks)],
    });
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });

    await speak(bridge.runTurn('what is the payout', CALLER));
    // 600 other numbers ring in, past the 500 the maps hold.
    for (let i = 0; i < 600; i++) {
      await speak(bridge.runTurn('hello', `+1666000${String(i).padStart(4, '0')}`));
    }
    // The original caller is still on the line and still held.
    const said = await speak(bridge.runTurn('so what is it', CALLER));
    assert.doesNotMatch(said, /13[,.]481/, 'eviction released an unapproved figure');
  });
});

test('every gate has a waiter before any of them is announced', async () => {
  // Announcing first and awaiting one at a time made a gate visible to an
  // operator with nothing listening for its answer, so a decision on the
  // second of two gates was dropped and that gate then hung. Found by Qodo.
  await withStore(async () => {
    const twoGates = {
      type: 'tool.approval_required',
      id: 'ev-approve-2',
      created_at: '2026-08-29T16:20:27.286Z',
      thread_id: 'main',
      tool_calls: [
        { id: 'call_one', source_event_id: LIVE_SOURCE_EVENT.id },
        { id: 'call_two', source_event_id: LIVE_SOURCE_EVENT.id },
      ],
    };
    const forge = stubForge({
      turns: [
        [message(LIVE_SOURCE_EVENT.id), twoGates as unknown as TurnEvent, done()],
        [message('m2'), delta('m2', 'done'), done()],
      ],
    });

    const waiting = new Set<string>();
    const announced: string[] = [];
    const bridge = createBridge({
      forge: forge.client,
      agentName: 'northvane',
      onApprovalRequired: (gate) => {
        announced.push(gate.tool_call_id);
        assert.ok(
          waiting.has(gate.tool_call_id),
          `${gate.tool_call_id} was announced with nothing waiting on it`,
        );
      },
      awaitApproval: async (gate) => {
        waiting.add(gate.tool_call_id);
        return { status: 'allow' };
      },
    });
    await speak(bridge.runTurn('is it totaled', CALLER));

    assert.deepEqual(announced, ['call_one', 'call_two']);
    // Both decisions have to reach the harness, not just the first.
    assert.deepEqual(
      (forge.inputs[1] ?? []).map((i) => (i as { tool_call_id?: string }).tool_call_id),
      ['call_one', 'call_two'],
    );
  });
});

test('an amount authorised on one call is not speakable on the next', async () => {
  // The same mistake authorisedAmountsByClaim in src/mcp/gated.ts was fixed
  // for once: an amount a human approved must not follow the phone number
  // into a claim they never saw.
  await withStore(async () => {
    const gated = [
      message(LIVE_SOURCE_EVENT.id),
      LIVE_APPROVAL as unknown as TurnEvent,
      done(),
    ];
    const statesTheFigure = [
      message('m2'),
      SETTLEMENT_RESPONSE as unknown as TurnEvent,
      message('m3'),
      delta('m3', 'We can settle at $13,481.12.'),
      done(),
    ];
    const forge = stubForge({ turns: [gated, statesTheFigure, statesTheFigure] });
    const options = {
      forge: forge.client,
      agentName: 'northvane',
      awaitApproval: async (): Promise<ApprovalDecision> => ({ status: 'allow' }),
    };

    // Call one: approved, so the figure is speakable.
    const first = createBridge(options);
    const heardFirst = await speak(first.runTurn('is it totaled', CALLER));
    assert.match(
      heardFirst,
      /13,481 dollars and 12 cents/,
      'an approved figure should be speakable',
    );

    // The call ends and the window closes, so ringing back is a new call.
    await new Promise((r) => setTimeout(r, 15));
    const second = createBridge({ ...options, resumeWindowMs: 5 });
    const heardSecond = await speak(second.runTurn('hello again', CALLER));

    assert.doesNotMatch(
      heardSecond,
      /13[,.]481/,
      'last call s approval made a figure speakable on a new call',
    );
  });
});

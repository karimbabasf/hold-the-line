import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createBridge,
  isSandboxRun,
  sandboxIdOf,
  sandboxUrl,
} from '../src/telephony/harness-bridge.ts';
import { TrueForgeError } from '../src/trueforge/client.ts';
import type { TrueForgeClient } from '../src/trueforge/client.ts';
import type { SandboxEvent } from '../src/console/events.ts';
import type { TurnEvent } from '../src/trueforge/types.ts';

/**
 * The container the console links to.
 *
 * The whole provenance claim is that a figure came out of code that ran, so
 * the panel saying so has to be driven by what the harness actually reports.
 * Every shape asserted here was captured off the live TrueForge on :8790 on
 * 2026-08-29, not invented: the `sandbox.created` fields, the `exec` response
 * envelope, and the fact that nothing marks the START of a run.
 */

const CALLER = '+14155550142';

function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'htl-sandbox-'));
  process.env.SESSION_STORE_PATH = join(dir, 'sessions.json');
  return dir;
}

/** One `exec` response, exactly as the harness sends it. */
const EXEC_RESPONSE = JSON.stringify({
  success: true,
  response: { exitCode: 0, result: '64.4\n' },
});

/** A `settlement.calculate` response, for contrast: MCP, not the container. */
const MCP_RESPONSE = JSON.stringify({
  is_total_loss: true,
  acv: 21340,
  net: 13481.12,
  run_id: 'run-mtdrop7c00',
});

/**
 * A harness that streams the given events.
 *
 * `pauseBefore` holds the stream for that many ms before the event at that
 * index, standing in for the silence a real container run leaves on the wire.
 */
function forgeReturning(
  events: TurnEvent[],
  sessionId = 'sess-7c21',
  pauseBefore?: { index: number; ms: number },
) {
  return {
    async createSession() {
      return sessionId;
    },
    async *streamTurn(): AsyncGenerator<TurnEvent> {
      for (const [i, event] of events.entries()) {
        if (pauseBefore && pauseBefore.index === i) {
          await new Promise((r) => setTimeout(r, pauseBefore.ms));
        }
        yield event;
      }
    },
  } as unknown as TrueForgeClient;
}

async function drain(gen: AsyncGenerator<{ text: string }>): Promise<void> {
  for await (const _ of gen) void _;
}

async function sandboxEventsFor(
  events: TurnEvent[],
  pauseBefore?: { index: number; ms: number },
): Promise<SandboxEvent[]> {
  const dir = tempStore();
  try {
    const seen: SandboxEvent[] = [];
    const bridge = createBridge({
      forge: forgeReturning(events, 'sess-7c21', pauseBefore),
      agentName: 'northvane',
      onConsoleEvent: (e) => {
        if (e.type === 'sandbox') seen.push(e);
      },
    });
    await drain(bridge.runTurn('claim 40218', CALLER));
    return seen;
  } finally {
    delete process.env.SESSION_STORE_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the session page is the link, and it is built the way a browser resolves it', () => {
  assert.equal(
    sandboxUrl('01m17kwn46bj5vgebfzhq0a5wr'),
    'http://localhost:8790/sessions/01m17kwn46bj5vgebfzhq0a5wr',
  );
  // The harness binds IPv6 only, so a link on 127.0.0.1 would not open.
  assert.ok(!sandboxUrl('sess-1').includes('127.0.0.1'));
  assert.equal(sandboxUrl('sess-1', 'http://[::1]:8790/'), 'http://[::1]:8790/sessions/sess-1');
});

test('only sandbox.created names a container', () => {
  // Copied off the wire on 2026-08-29, field for field.
  const created: { type: string } = {
    type: 'sandbox.created',
    id: '01m17mw1xxk4b8aj9qzcp51tnk',
    created_at: '2026-08-29T20:55:08.989Z',
    thread_id: null,
    sandbox_id: 'v1:daytona:default.a05c9b35-16eb-4394-9f59-1401fa3befcb',
  } as { type: string };
  assert.equal(sandboxIdOf(created), 'v1:daytona:default.a05c9b35-16eb-4394-9f59-1401fa3befcb');

  const message: { type: string } = { type: 'model.message' };
  assert.equal(sandboxIdOf(message), null);
  // The type alone is not enough: an event that forgets the id names nothing.
  assert.equal(sandboxIdOf({ type: 'sandbox.created' }), null);
});

test('an exec response is a container run and an MCP response is not', () => {
  assert.equal(isSandboxRun(EXEC_RESPONSE), true);
  assert.equal(isSandboxRun(MCP_RESPONSE), false);
  // Several MCP tools answer with prose rather than JSON.
  assert.equal(isSandboxRun('I have got your file here.'), false);
  assert.equal(isSandboxRun(undefined), false);
});

test('the container is announced once, with a link, before any code has run', async () => {
  const seen = await sandboxEventsFor([{ type: 'model.message.delta', content: 'ok' }]);

  assert.deepEqual(
    seen.map((e) => e.status),
    ['attached'],
    'a turn that ran no code should announce the session and nothing else',
  );
  const [attached] = seen;
  assert.equal(attached?.url, 'http://localhost:8790/sessions/sess-7c21');
  // No container exists yet, so the id is the session's. Inventing a
  // container id here would be the exact overclaim this panel exists to
  // rule out.
  assert.equal(attached?.id, 'sess-7c21');
});

test('a container run reports running then idle, dated across the silence it took', async () => {
  // The wire order captured live: the message opens, prose streams, then the
  // harness goes quiet for the length of the run, then `sandbox.created` and
  // the response arrive together.
  const seen = await sandboxEventsFor(
    [
      { type: 'model.message', id: 'msg-1' } as unknown as TurnEvent,
      { type: 'model.message.delta', content: 'Checking on that now.' },
      {
        type: 'sandbox.created',
        id: '01m17mw1xxk4b8aj9qzcp51tnk',
        sandbox_id: 'v1:daytona:default.a05c9b35-16eb-4394-9f59-1401fa3befcb',
      } as unknown as TurnEvent,
      {
        type: 'tool.response',
        tool_call_id: 'call_dfHEbP1Yp7yEkDiC1bsc0UeE',
        content: EXEC_RESPONSE,
      } as unknown as TurnEvent,
    ],
    { index: 2, ms: 60 },
  );

  assert.deepEqual(seen.map((e) => e.status), ['attached', 'running', 'idle']);

  const running = seen[1];
  const idle = seen[2];
  assert.equal(running?.label, 'exec');
  // The id upgrades to the real container once the harness names it.
  assert.equal(running?.id, 'v1:daytona:default.a05c9b35-16eb-4394-9f59-1401fa3befcb');
  assert.equal(idle?.id, 'v1:daytona:default.a05c9b35-16eb-4394-9f59-1401fa3befcb');
  assert.equal(idle?.url, 'http://localhost:8790/sessions/sess-7c21');
  // The window spans the silence, so it is a window and not an instant.
  // `sandbox.created` arriving inside that silence must not close it early.
  const width = (idle?.t ?? 0) - (running?.t ?? 0);
  assert.ok(width >= 50, `running to idle was ${width}ms, so the run showed as instant`);
  // No run id: a container run mints none, and the ones on the numbers come
  // from settle() in the MCP process.
  assert.equal(idle?.run_id, undefined);
});

test('an MCP tool answering does not light the container', async () => {
  const seen = await sandboxEventsFor([
    { type: 'model.message', id: 'msg-1' } as unknown as TurnEvent,
    {
      type: 'tool.response',
      tool_call_id: 'call_QTHU0VObFqzlezUrAhiugaXp',
      content: MCP_RESPONSE,
    } as unknown as TurnEvent,
    { type: 'model.message.delta', content: 'You are at 13,481 dollars and 12 cents.' },
  ]);

  assert.deepEqual(
    seen.map((e) => e.status),
    ['attached'],
    'settlement.calculate runs in the MCP process, so it must not report a container run',
  );
});

test('a session the harness has lost is reported gone, and its replacement attached', async () => {
  const dir = tempStore();
  try {
    let created = 0;
    const gone = new Set<string>();
    const client = {
      async createSession() {
        created += 1;
        return `sess-${created}`;
      },
      async *streamTurn(sessionId: string): AsyncGenerator<TurnEvent> {
        if (gone.has(sessionId)) {
          throw new TrueForgeError(
            `POST /api/v1/sessions/${sessionId}/turns failed with 404`,
            404,
            '{}',
          );
        }
        yield { type: 'model.message.delta', content: 'ok' };
      },
    } as unknown as TrueForgeClient;

    const first = createBridge({ forge: client, agentName: 'northvane' });
    await drain(first.runTurn('claim 40218', CALLER));
    gone.add('sess-1');

    const seen: SandboxEvent[] = [];
    const second = createBridge({
      forge: client,
      agentName: 'northvane',
      onConsoleEvent: (e) => {
        if (e.type === 'sandbox') seen.push(e);
      },
    });
    await drain(second.runTurn('are you still there', CALLER));

    assert.deepEqual(seen.map((e) => e.status), ['attached', 'gone', 'attached']);
    assert.equal(seen[1]?.url, 'http://localhost:8790/sessions/sess-1');
    assert.equal(seen[2]?.url, 'http://localhost:8790/sessions/sess-2');
  } finally {
    delete process.env.SESSION_STORE_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The link has to open, not merely be well formed.
 *
 * TrueForge serves the SPA on this route only for a browser's Accept header
 * and answers a JSON 404 to anything else, which is exactly the trap a
 * hand-checked link falls into. Skipped when the harness is not running, so
 * the suite stays green off the demo machine.
 */
test('the session link really loads in the harness UI', async (t) => {
  const url = sandboxUrl('01m17kwn46bj5vgebfzhq0a5wr');
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    t.skip('TrueForge is not running on :8790');
    return;
  }
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.ok(body.includes('<div id="root"'), 'the route served something other than the UI');
});

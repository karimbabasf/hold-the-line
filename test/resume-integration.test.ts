import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBridge } from '../src/telephony/harness-bridge.ts';
import type { TrueForgeClient } from '../src/trueforge/client.ts';
import type { TurnEvent } from '../src/trueforge/types.ts';

/**
 * The drop-and-resume beat, end to end through the bridge.
 *
 * This is the moment in the demo where the caller's line dies, they ring
 * back, and the agent carries on mid-thought instead of starting over. Qodo
 * flagged that the store existed but nothing called it, so this asserts the
 * wiring rather than the store.
 */

const CALLER = '+14155550142';

function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'htl-resume-'));
  process.env.SESSION_STORE_PATH = join(dir, 'sessions.json');
  return dir;
}

/** A harness stub that counts how many sessions were ever created. */
function stubForge() {
  let created = 0;
  const client = {
    async createSession() {
      created += 1;
      return `sess-${created}`;
    },
    async *streamTurn(): AsyncGenerator<TurnEvent> {
      yield { type: 'model.message.delta', content: 'ok' };
    },
  };
  return { client: client as unknown as TrueForgeClient, sessionsCreated: () => created };
}

async function drain(gen: AsyncGenerator<{ text: string }>): Promise<void> {
  for await (const _ of gen) {
    /* consume */
  }
}

test('a caller ringing back inside the window keeps the same harness session', async () => {
  const dir = tempStore();
  try {
    const forge = stubForge();

    // First call.
    const first = createBridge({ forge: forge.client, agentName: 'northvane' });
    await drain(first.runTurn('claim 40218', CALLER));
    assert.equal(forge.sessionsCreated(), 1);

    // The line dies. A new bridge stands in for the process losing its map.
    const second = createBridge({ forge: forge.client, agentName: 'northvane' });
    await drain(second.runTurn('sorry, i lost you', CALLER));

    // Nothing was recreated: the same harness conversation was picked back up.
    assert.equal(forge.sessionsCreated(), 1, 'a second session means the resume did not fire');
    assert.equal(second.wasResumed(CALLER), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SESSION_STORE_PATH;
  }
});

test('a caller outside the window starts fresh', async () => {
  const dir = tempStore();
  try {
    const forge = stubForge();

    const first = createBridge({ forge: forge.client, agentName: 'northvane' });
    await drain(first.runTurn('claim 40218', CALLER));

    // Let the checkpoint genuinely age out rather than testing the boundary
    // at zero, which is a different question.
    await new Promise((r) => setTimeout(r, 15));
    const later = createBridge({
      forge: forge.client,
      agentName: 'northvane',
      resumeWindowMs: 5,
    });
    await drain(later.runTurn('hello?', CALLER));

    assert.equal(forge.sessionsCreated(), 2);
    assert.equal(later.wasResumed(CALLER), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SESSION_STORE_PATH;
  }
});

test('a different caller never inherits somebody else s session', async () => {
  const dir = tempStore();
  try {
    const forge = stubForge();
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });

    await drain(bridge.runTurn('claim 40218', CALLER));
    await drain(bridge.runTurn('different person', '+14155550199'));

    assert.equal(forge.sessionsCreated(), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SESSION_STORE_PATH;
  }
});

test('a checkpoint failure does not take the call down', async () => {
  const dir = tempStore();
  try {
    // Point the store at a path that cannot be written.
    process.env.SESSION_STORE_PATH = '/nonexistent-directory-htl/sessions.json';
    const forge = stubForge();
    const bridge = createBridge({ forge: forge.client, agentName: 'northvane' });

    const said: string[] = [];
    for await (const d of bridge.runTurn('claim 40218', CALLER)) said.push(d.text);

    // The caller still got their answer.
    assert.deepEqual(said, ['ok']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SESSION_STORE_PATH;
  }
});

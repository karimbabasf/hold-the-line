import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBridge } from '../src/telephony/harness-bridge.ts';
import { TrueForgeError } from '../src/trueforge/client.ts';
import type { TrueForgeClient } from '../src/trueforge/client.ts';
import type { TurnEvent } from '../src/trueforge/types.ts';

/**
 * The checkpoint outlives the harness.
 *
 * The harness is a local process and a restart takes every session with it,
 * while the row on disk survives. A live call died on exactly this: the store
 * handed back an id the harness had never heard of, the turn came back 404,
 * and the caller heard "something went wrong on my end" instead of a greeting.
 */

const CALLER = '+14155550142';

function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'htl-stale-'));
  process.env.SESSION_STORE_PATH = join(dir, 'sessions.json');
  return dir;
}

/** A harness that forgets every session it made before `forgetAll()`. */
function forgetfulForge() {
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
          JSON.stringify({ error: { message: `Session not found: ${sessionId}` } }),
        );
      }
      yield { type: 'model.message.delta', content: 'ok' };
    },
  };
  return {
    client: client as unknown as TrueForgeClient,
    created: () => created,
    forgetAll: () => { for (let i = 1; i <= created; i++) gone.add(`sess-${i}`); },
  };
}

async function spoken(gen: AsyncGenerator<{ text: string }>): Promise<string> {
  let out = '';
  for await (const d of gen) out += d.text;
  return out;
}

test('a resumed session the harness has forgotten starts a fresh one instead of failing the call', async () => {
  const dir = tempStore();
  try {
    const forge = forgetfulForge();

    const first = createBridge({ forge: forge.client, agentName: 'northvane' });
    await spoken(first.runTurn('claim 40218', CALLER));
    assert.equal(forge.created(), 1);

    // The harness restarts. The checkpoint on disk still names sess-1.
    forge.forgetAll();

    const second = createBridge({ forge: forge.client, agentName: 'northvane' });
    const heard = await spoken(second.runTurn('are you still there', CALLER));

    assert.equal(heard, 'ok', 'the caller heard nothing, so the call died on a stale id');
    assert.equal(forge.created(), 2, 'no fresh session was made after the 404');
  } finally {
    delete process.env.SESSION_STORE_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

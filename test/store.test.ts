import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkpoint, resume } from '../src/session/store.ts';

/**
 * Every test gets its own store file so they cannot see each other's
 * writes and cannot race each other's env var when node:test parallelises
 * a file's tests. Nothing here touches data/sessions.json.
 */
function freshStorePath(): string {
  return join(tmpdir(), `htl-sessions-${randomUUID()}.json`);
}

test('a resumed call carries the same run ids, proving nothing was recomputed', async () => {
  process.env.SESSION_STORE_PATH = freshStorePath();
  await checkpoint('+14155550142', {
    run_ids: ['run-7c21'],
    pending_draft: 'draft',
    transcript_index: 12,
  });
  const s = await resume('+14155550142', 10 * 60_000);
  assert.deepEqual(s?.run_ids, ['run-7c21']);
  assert.equal(s?.pending_draft, 'draft');
});

test('a checkpoint older than the window does not resume', async () => {
  process.env.SESSION_STORE_PATH = freshStorePath();
  await checkpoint('+14155550199', { run_ids: [] }, Date.now() - 11 * 60_000);
  assert.equal(await resume('+14155550199', 10 * 60_000), null);
});

test('resume points at the exact open turn, not the start of the call', async () => {
  process.env.SESSION_STORE_PATH = freshStorePath();
  const phone = '+14155550150';
  await checkpoint(phone, { transcript_index: 9, run_ids: ['run-a1'] });
  const s = await resume(phone, 10 * 60_000);
  // transcript_index is what lets the caller-facing line name the open
  // question ("you were asking about the payoff") instead of a greeting.
  // A default back to 0 would read as a restart, not a resume.
  assert.equal(s?.transcript_index, 9);
});

test('a gate draft mid-edit survives the drop', async () => {
  process.env.SESSION_STORE_PATH = freshStorePath();
  const phone = '+14155550151';
  const draft = 'Northvane can settle your claim today at 13,481 dollars and 12 cents, final.';
  await checkpoint(phone, {
    pending_draft: draft,
    gate_state: { tool: 'offer.state_settlement', status: 'pending' },
  });
  const s = await resume(phone, 10 * 60_000);
  assert.equal(s?.pending_draft, draft);
  assert.deepEqual(s?.gate_state, { tool: 'offer.state_settlement', status: 'pending' });
});

test('a missing store file returns null instead of throwing', async () => {
  process.env.SESSION_STORE_PATH = freshStorePath(); // never written
  assert.equal(await resume('+14155550161', 10 * 60_000), null);
});

test('a corrupt store file returns null instead of throwing', async () => {
  const path = freshStorePath();
  process.env.SESSION_STORE_PATH = path;
  await writeFile(path, '{ this is not json', 'utf8');
  assert.equal(await resume('+14155550160', 10 * 60_000), null);
});

test('a corrupt store file does not block a later checkpoint', async () => {
  const path = freshStorePath();
  process.env.SESSION_STORE_PATH = path;
  await writeFile(path, '{ this is not json', 'utf8');
  await checkpoint('+14155550162', { transcript_index: 1 });
  const s = await resume('+14155550162', 10 * 60_000);
  assert.equal(s?.transcript_index, 1);
});

test('concurrent checkpoints for one number do not corrupt the file', async () => {
  const path = freshStorePath();
  process.env.SESSION_STORE_PATH = path;
  const phone = '+14155550170';
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      checkpoint(phone, { transcript_index: i, run_ids: [`run-${i}`] }),
    ),
  );

  // Whichever write landed last, the file must still be one intact JSON
  // object. A torn write here would fail resume() for every caller, not
  // just this one, which is why temp-file-plus-rename is not optional.
  const raw = await readFile(path, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));

  const s = await resume(phone, 60_000);
  assert.notEqual(s, null);
});

test('concurrent checkpoints for different numbers all land, none lost', async () => {
  process.env.SESSION_STORE_PATH = freshStorePath();
  const phones = ['+14155550171', '+14155550172', '+14155550173'];
  await Promise.all(phones.map((p, i) => checkpoint(p, { transcript_index: i })));
  const results = await Promise.all(phones.map((p) => resume(p, 60_000)));
  assert.deepEqual(
    results.map((r) => r?.transcript_index),
    [0, 1, 2],
  );
});

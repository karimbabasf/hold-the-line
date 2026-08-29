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

test('a corrupt store file is not silently overwritten by the next checkpoint', async () => {
  const path = freshStorePath();
  process.env.SESSION_STORE_PATH = path;
  await writeFile(path, '{ this is not json', 'utf8');

  // Must not throw: a broken store can never take a live call down.
  await checkpoint('+14155550162', { transcript_index: 1 });

  // Must also not have clobbered the file. The old behaviour treated any
  // read failure as an empty store and wrote straight over it, which would
  // silently erase every other caller's checkpoint over what might be a
  // transient read error. The file is left exactly as broken as it was,
  // for a human to recover, rather than replaced with just this one entry.
  assert.equal(await readFile(path, 'utf8'), '{ this is not json');

  // resume() still degrades to null rather than throwing.
  assert.equal(await resume('+14155550162', 10 * 60_000), null);
});

test('a malformed individual record does not resume even though the file is valid JSON', async () => {
  const path = freshStorePath();
  process.env.SESSION_STORE_PATH = path;
  // Written by hand, not through checkpoint(): valid JSON, but the entry is
  // missing checkpointed_at. Date.now() - undefined is NaN, and NaN is
  // neither greater than nor less than the window, so a naive age check
  // would let this through as if it were a fresh checkpoint.
  await writeFile(path, JSON.stringify({ '+14155550163': { pending_draft: 'x' } }), 'utf8');
  assert.equal(await resume('+14155550163', 10 * 60_000), null);
});

test('a non-object record does not resume', async () => {
  const path = freshStorePath();
  process.env.SESSION_STORE_PATH = path;
  await writeFile(path, JSON.stringify({ '+14155550164': 'not an object' }), 'utf8');
  assert.equal(await resume('+14155550164', 10 * 60_000), null);
});

test('a caller id that collides with a prototype property name stores and resumes safely', async () => {
  process.env.SESSION_STORE_PATH = freshStorePath();
  // "__proto__" as a plain object key does not create an own property by
  // default, it reassigns the object's prototype through the inherited
  // setter. Telnyx passes the caller id through unvalidated, so this is
  // reachable, not just theoretical.
  await checkpoint('__proto__', { transcript_index: 5 });
  const polluted = await resume('__proto__', 60_000);
  assert.equal(polluted?.transcript_index, 5);

  // And an unrelated, ordinary number checkpointed afterward is unaffected,
  // proving the store's prototype itself was never touched.
  await checkpoint('+14155550190', { transcript_index: 1 });
  const normal = await resume('+14155550190', 60_000);
  assert.equal(normal?.transcript_index, 1);
});

test('the harness session id survives a resume', async () => {
  process.env.SESSION_STORE_PATH = freshStorePath();
  const phone = '+14155550153';
  // This is what lets the bridge reconnect to the same TrueForge
  // conversation after its own process restarts, rather than starting a
  // fresh, empty session and losing everything the model itself remembers.
  await checkpoint(phone, { harness_session_id: 'sess-7c21', transcript_index: 3 });
  const s = await resume(phone, 60_000);
  assert.equal(s?.harness_session_id, 'sess-7c21');
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

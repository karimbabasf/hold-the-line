/**
 * Session suspend and resume, keyed on caller phone number.
 *
 * A JSON file, not a state machine: on disconnect the bridge checkpoints
 * whatever it is holding for that caller, and on the next inbound call from
 * the same number within the window, resume() hands the same dict back
 * untouched. This is the disk-backed replacement the comment in
 * harness-bridge.ts points at (see that file's `sessions` map).
 *
 * Three things have to survive a round trip for a resume to read as real
 * instead of as a reset, and each has a dedicated test in store.test.ts:
 *   - `transcript_index` comes back exact, so the caller-facing line can
 *     name the open question instead of defaulting to a greeting.
 *   - `run_ids` come back identical, proving the figures were not
 *     recomputed, only reloaded.
 *   - `pending_draft` (and `gate_state`) survive a drop mid-edit.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SessionState {
  computed_results?: unknown;
  pending_draft?: string | null;
  transcript_index?: number;
  gate_state?: unknown;
  run_ids?: string[];
}

export interface StoredSession extends SessionState {
  /** epoch ms the checkpoint was written. Used to enforce the resume
   *  window, and available to callers that want to show how long the
   *  caller has been off the line. */
  checkpointed_at: number;
}

type StoreFile = Record<string, StoredSession>;

/** Spec section 1 item 6: "within ten minutes." Exported so the wiring
 *  code does not have to repeat the magic number. */
export const DEFAULT_RESUME_WINDOW_MS = 10 * 60_000;

// Repo-root data/, resolved from this module's own URL rather than
// process.cwd() so it is correct no matter where the server is started
// from. Matches the fixtures.ts convention. Overridable via env so tests
// never touch, or race each other over, the real checkpoint file.
const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'sessions.json');

function storePath(): string {
  return process.env.SESSION_STORE_PATH ?? DEFAULT_PATH;
}

// Every read-modify-write goes through this one in-process chain, so two
// checkpoint() calls that overlap (two different callers, or the same
// caller checkpointing twice in quick succession) never both read the file
// before either has written it, which would silently drop one of the two
// updates. A single Node process is the only concurrency this needs to
// survive; two processes sharing one file is out of scope.
let queue: Promise<void> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isStoreFile(value: unknown): value is StoreFile {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readStore(path: string): Promise<StoreFile> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isStoreFile(parsed) ? parsed : {};
  } catch {
    // Missing file, unreadable file, or invalid JSON all land here. A
    // broken checkpoint must never take a live call down, so this degrades
    // to "nobody has a checkpoint" instead of throwing.
    return {};
  }
}

async function writeStore(path: string, data: StoreFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Write beside the real file, then rename over it. rename() is atomic on
  // the same filesystem, so a reader (or a second writer) never observes a
  // half-written file. The random suffix means two overlapping writers
  // never share, and so never race on, the same temp file.
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, path);
}

export async function checkpoint(
  phone: string,
  state: SessionState,
  atMs: number = Date.now(),
): Promise<void> {
  const path = storePath();
  await serialize(async () => {
    const store = await readStore(path);
    store[phone] = { ...(store[phone] ?? {}), ...state, checkpointed_at: atMs };
    await writeStore(path, store);
  });
}

export async function resume(phone: string, withinMs: number): Promise<StoredSession | null> {
  const store = await readStore(storePath());
  const found = store[phone];
  if (!found || Date.now() - found.checkpointed_at > withinMs) return null;
  return found;
}

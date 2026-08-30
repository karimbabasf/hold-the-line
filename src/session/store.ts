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
 *
 * `harness_session_id` is separate from those three: it is what lets the
 * bridge reconnect to the *same* TrueForge conversation after its own
 * process restarts, rather than only after a call leg drops while the
 * process stays up. The bridge's in-memory map already covers the second
 * case; this field is what the disk-backed store adds on top of it.
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
  /** The TrueForge session id the bridge is holding for this caller. Without
   *  this, a resume after the *telephony process itself* restarts can only
   *  start a fresh, empty TrueForge session: the other four fields describe
   *  what to say, but not which live conversation to keep saying it in. */
  harness_session_id?: string;
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
// Checkpoints hold caller phone numbers, so the directory is 0700 and the
// file 0600. Node's defaults are 0777 and 0666 before umask, which on a
// common 022 leaves both world readable.
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

/** A record only counts as a real checkpoint if it carries a numeric
 *  timestamp: without this check, a hand-edited or half-written entry with
 *  a missing or non-numeric `checkpointed_at` produced `NaN` out of the age
 *  comparison, which is neither `true` nor `false` for "greater than the
 *  window" and so was returned as if it were a fresh, valid checkpoint. */
function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const at = (value as { checkpointed_at?: unknown }).checkpointed_at;
  return typeof at === 'number' && Number.isFinite(at);
}

/** Reads an entry by own property only. `store[phone]` would also return
 *  anything the object inherits from `Object.prototype` (`toString`,
 *  `constructor`, and so on), and a caller id of exactly `"__proto__"` or
 *  `"constructor"` is attacker-reachable: Telnyx passes the caller id
 *  through as an unvalidated string. `isStoredSession` rejects those
 *  shapes too, but checking ownership first is the more direct fix. */
function getEntry(store: StoreFile, phone: string): StoredSession | undefined {
  return Object.hasOwn(store, phone) ? store[phone] : undefined;
}

/** Writes an entry with Object.defineProperty rather than `store[phone] =
 *  value`. Bracket assignment for the literal key "__proto__" does not
 *  create an own property on a normal object: it invokes the inherited
 *  `Object.prototype.__proto__` setter and replaces the store's prototype
 *  instead, which would corrupt every other entry's lookups. defineProperty
 *  always creates or overwrites an own data property, whatever the key. */
function setEntry(store: StoreFile, phone: string, session: StoredSession): void {
  Object.defineProperty(store, phone, {
    value: session,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** Throws on anything other than "the file does not exist yet", which
 *  checkpoint() and resume() then handle differently: a missing file is a
 *  normal empty store, but a present-and-broken file is not something
 *  checkpoint() may paper over by silently replacing it (see checkpoint()).
 */
async function readStore(path: string): Promise<StoreFile> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isMissingFileError(err)) return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  return isStoreFile(parsed) ? parsed : {};
}

async function writeStore(path: string, data: StoreFile): Promise<void> {
  // Checkpoints hold caller phone numbers. Node defaults to 0777 and 0666
  // before umask, which on a common 022 leaves both world readable.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Write beside the real file, then rename over it. rename() is atomic on
  // the same filesystem, so a reader (or a second writer) never observes a
  // half-written file. The random suffix means two overlapping writers
  // never share, and so never race on, the same temp file.
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

export async function checkpoint(
  phone: string,
  state: SessionState,
  atMs: number = Date.now(),
): Promise<void> {
  const path = storePath();
  await serialize(async () => {
    let store: StoreFile;
    try {
      store = await readStore(path);
    } catch (err) {
      // The file exists but could not be read or parsed (bad permissions, a
      // transient I/O error, or JSON that got corrupted some other way).
      // readStore() already treats "missing" as a normal empty store, so
      // reaching here means something is actually wrong. Writing anyway
      // would replace it with a store holding only this one caller, which
      // silently erases every other session on disk over what might be a
      // recoverable problem. Refuse instead: the live call carries on
      // either way, and the broken file is left for a human to look at.
      console.error(`session store: refusing to checkpoint ${phone}, could not read the existing store:`, err);
      return;
    }
    setEntry(store, phone, { ...(getEntry(store, phone) ?? {}), ...state, checkpointed_at: atMs });
    await writeStore(path, store);
  });
}

/**
 * Drops every checkpoint on disk.
 *
 * The operator's reset means the next call is a new call. A checkpoint still
 * inside the resume window would otherwise hand that call the previous
 * conversation's harness session, transcript and all, which is the opposite
 * of what the button says. Goes through the same serialize chain as
 * checkpoint(), so a write already in flight cannot land after the wipe and
 * resurrect the session that was just discarded.
 */
export async function forgetAll(): Promise<void> {
  const path = storePath();
  await serialize(async () => {
    await writeStore(path, {});
  });
}

export async function resume(phone: string, withinMs: number): Promise<StoredSession | null> {
  let store: StoreFile;
  try {
    store = await readStore(storePath());
  } catch {
    // Missing, unreadable, or invalid JSON. A broken checkpoint must never
    // take a live call down, so this degrades to "nobody has a checkpoint"
    // instead of throwing.
    return null;
  }
  const found = getEntry(store, phone);
  if (!isStoredSession(found)) return null;
  if (Date.now() - found.checkpointed_at > withinMs) return null;
  return found;
}

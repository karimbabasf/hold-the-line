#!/usr/bin/env node
/**
 * Publishes agent.json to the running harness, then reads it back and proves
 * it landed.
 *
 * Nothing used to publish this file. The README's `POST /api/v1/agents`
 * creates the agent once and returns 409 on every repeat, so every edit to
 * the instructions since the first start has been sitting in a file the
 * harness never re-read. A voice fix that never reaches the assistant is not
 * a fix.
 *
 * PUT /api/v1/agents/{id} with `{ manifest }` is the idempotent route, so a
 * repeated start is safe and a first start still works through the POST
 * fallback below.
 *
 * The read-back is the point, not a formality. The harness accepts a manifest
 * with 200 and silently drops fields it does not recognise:
 * `model.reasoning_effort` was dropped on every publish while
 * `model.params.reasoning_effort` is stored, so the agent ran at the provider
 * default rather than the medium the file asked for and nothing said so. Any
 * field this sends and does not get back is an error, loudly.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;
const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent.json');

/**
 * Paths where `ours` is missing from, or differs in, `theirs`.
 *
 * A subset check rather than a deep equal: the harness fills in its own
 * defaults (iteration_limit, context_management, and more), and those are not
 * drift. Only what this file actually asked for has to come back.
 */
function missing(ours, theirs, path = '') {
  if (Array.isArray(ours)) {
    if (!Array.isArray(theirs) || theirs.length !== ours.length) return [path || '(root)'];
    return ours.flatMap((v, i) => missing(v, theirs[i], `${path}[${i}]`));
  }
  if (ours && typeof ours === 'object') {
    if (!theirs || typeof theirs !== 'object') return [path || '(root)'];
    return Object.entries(ours).flatMap(([k, v]) =>
      missing(v, theirs[k], path ? `${path}.${k}` : k),
    );
  }
  return ours === theirs ? [] : [path || '(root)'];
}

async function json(method, url, body) {
  const res = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { ok: res.ok, status: res.status, text, body: parsed };
}

const local = JSON.parse(await readFile(FILE, 'utf8'));
const { name, manifest } = local;
if (!name || !manifest) {
  console.error('agent.json needs a name and a manifest');
  process.exit(1);
}

const list = await json('GET', `${API}/agents`);
if (!list.ok) {
  console.error(`could not list agents: ${list.status} ${list.text.slice(0, 200)}`);
  process.exit(1);
}
const existing = (list.body?.data ?? []).find((a) => a.name === name);

const wrote = existing
  ? await json('PUT', `${API}/agents/${existing.id}`, { manifest })
  : await json('POST', `${API}/agents`, local);
if (!wrote.ok) {
  console.error(
    `could not ${existing ? 'update' : 'create'} agent "${name}": ` +
      `${wrote.status} ${wrote.text.slice(0, 300)}`,
  );
  process.exit(1);
}

// Read back off the harness rather than trusting the write's own echo.
const after = await json('GET', `${API}/agents`);
const stored = (after.body?.data ?? []).find((a) => a.name === name);
if (!stored) {
  console.error(`published "${name}" but it is not in the agent list`);
  process.exit(1);
}

const dropped = missing(manifest, stored.manifest);
if (dropped.length > 0) {
  console.error(`     agent "${name}" published, but the harness did not keep:`);
  for (const p of dropped) {
    console.error(`       ${p}: sent ${JSON.stringify(at(manifest, p))}, stored ${JSON.stringify(at(stored.manifest, p))}`);
  }
  process.exit(1);
}

const effort = stored.manifest.model?.params?.reasoning_effort ?? '(provider default)';
console.log(
  `     agent "${name}" ${existing ? 'updated' : 'created'}, read back clean ` +
    `(${stored.manifest.model?.name}, reasoning effort ${effort})`,
);

/** Reads a dotted path like `model.params.reasoning_effort` out of an object. */
function at(obj, path) {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Typecheck passing is not the same as the file loading. Node's strip-only
 * mode rejects syntax that needs code generation (parameter properties,
 * enums, namespaces), and that failure only appears at runtime. This client
 * shipped a TrueForgeError with parameter properties that typechecked cleanly
 * and crashed on import, so this walks every module and imports it.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    // Entrypoints that bind a port are excluded; their logic lives in
    // importable modules precisely so this guard can reach it.
    return full.endsWith('.ts') && !full.endsWith('server.ts') ? [full] : [];
  });
}

test('every src module loads under --experimental-strip-types', async () => {
  const files = walk('src');
  assert.ok(files.length > 0, 'found no modules to check');
  for (const file of files) {
    await import(`../${file}`);
  }
});

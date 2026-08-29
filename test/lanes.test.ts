import assert from 'node:assert/strict';
import test from 'node:test';

import { LANES } from '../src/mcp/lanes.ts';
import { runDemoFanout, runLanes } from '../src/mcp/server.ts';

test('the five lanes match the demo script exactly, staggered and ascending', () => {
  // Spec section 7: lanes returning in 200ms kill the parallel argument on
  // camera. Pinned here so a future edit cannot quietly shrink them back to
  // decoration.
  assert.equal(LANES.length, 5);
  assert.deepEqual(
    LANES.map((l) => l.tool),
    [
      'policy.lookup',
      'valuation.comps',
      'lienholder.payoff_quote',
      'claims_history.get',
      'state_rules.get',
    ],
  );
  assert.deepEqual(
    LANES.map((l) => l.delayMs),
    [1100, 1600, 2200, 2800, 3400],
  );
  for (const lane of LANES) {
    assert.ok(lane.delayMs >= 1000, `${lane.name} is under a second, too fast to read as real`);
  }
});

test('lanes run concurrently, not serially', async () => {
  const started = Date.now();
  const res = await runLanes(LANES, async (lane) => {
    await new Promise((r) => setTimeout(r, lane.delayMs));
    return lane.name;
  });
  const elapsed = Date.now() - started;
  const configuredSerial = LANES.reduce((a, l) => a + l.delayMs, 0); // 11100

  assert.deepEqual(
    res.results,
    LANES.map((l) => l.name),
  );
  // Concurrent: wall time is close to the slowest lane (3400ms), nowhere
  // near the sum of all five.
  assert.ok(elapsed < configuredSerial / 2, `took ${elapsed}ms, serial would be ${configuredSerial}ms`);

  // serial_ms sums OBSERVED per-lane durations, not the configured delays,
  // so the on-screen counter stays honest if a real lane runs slow. A
  // setTimeout is a floor, not an exact value, so this checks it lands
  // close to the configured sum rather than bit-for-bit equal to it.
  assert.ok(
    res.serial_ms >= configuredSerial,
    `serial_ms ${res.serial_ms} should be at least the configured sum ${configuredSerial}`,
  );
  assert.ok(
    res.serial_ms < configuredSerial + 1000,
    `serial_ms ${res.serial_ms} drifted too far past the configured sum ${configuredSerial}`,
  );

  // parallel_ms tracks the slowest lane (3400ms), not the sum.
  assert.ok(res.parallel_ms >= 3400 && res.parallel_ms < configuredSerial);
});

test('runDemoFanout runs the real tools concurrently and reads real fixtures', async () => {
  // Same property as above, but end to end: real fixture-backed tool
  // handlers, real lane delays, no synthetic exec. This is the actual "3.4s
  // parallel vs 11.1s serial" counter, generated from a run rather than
  // hard-coded.
  const res = await runDemoFanout();
  const configuredSerial = LANES.reduce((a, l) => a + l.delayMs, 0);

  assert.equal(res.results.length, 5);
  assert.ok(res.parallel_ms < configuredSerial / 2);
  assert.ok(res.serial_ms >= configuredSerial);

  for (const raw of res.results) {
    const result = raw as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.ok(result.content[0]?.text.length, 'a lane returned no content');
  }

  // Spot check one lane's payload actually came from the fixtures, not a
  // stub: state_rules.get for AZ must carry the 75% threshold section 4.3
  // reconciles against.
  const stateRulesRaw = res.results[4] as { content: Array<{ text: string }> };
  const stateRules = JSON.parse(stateRulesRaw.content[0]?.text ?? '{}') as {
    total_loss_threshold_pct: number;
  };
  assert.equal(stateRules.total_loss_threshold_pct, 75.0);
});

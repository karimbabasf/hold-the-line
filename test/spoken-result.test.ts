import assert from 'node:assert/strict';
import test from 'node:test';

import { spokenResult } from '../src/mcp/server.ts';

/**
 * A binding sentence, not the envelope around it.
 *
 * Captured on the deployed stack: the agent is told to say what
 * `offer.state_settlement` returns word for word, the tool returned a JSON
 * object, and the caller heard
 * `{"claim_id":"CLM-40218","wanted":"...","said":"...","authorised_amounts":[...]}`
 * read out loud.
 */
test('a result carrying approved text reaches the model as that text alone', () => {
  const said = 'Northvane can settle this claim at $13,481.12.';
  const text = spokenResult({
    claim_id: 'CLM-40218',
    wanted: said,
    said,
    authorised_amounts: [13481.12],
  });

  assert.equal(text, said);
  assert.ok(!text.includes('{'), text);
  assert.ok(!text.includes('authorised_amounts'), text);
});

test('every other tool result still reaches the model as JSON', () => {
  // The model summarises an ordinary lookup. Only operator-filed wording is
  // repeated verbatim, so only that case is unwrapped.
  const record = { claim_id: 'CLM-40218', repair_estimate: 16780 };
  assert.equal(spokenResult(record), JSON.stringify(record));
  assert.equal(spokenResult(null), 'null');
  assert.equal(spokenResult({ said: 42 }), JSON.stringify({ said: 42 }));
});

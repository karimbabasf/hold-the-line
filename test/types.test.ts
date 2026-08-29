import assert from 'node:assert/strict';
import test from 'node:test';

import { isApprovalRequired } from '../src/trueforge/types.ts';

test('narrows a well-formed approval event', () => {
  assert.equal(
    isApprovalRequired({
      type: 'tool.approval_required',
      id: 'e1',
      created_at: 'now',
      thread_id: 'main',
      tool_calls: [{ id: 'call-1' }],
    }),
    true,
  );
});

test('rejects an approval event missing the fields the resume needs', () => {
  // Matching on type alone hands back an object whose thread_id and
  // tool_calls are typed as present and are not, and the resume built from
  // them fails far away with an unrelated server error. Found by Qodo.
  assert.equal(isApprovalRequired({ type: 'tool.approval_required' }), false);
  assert.equal(
    isApprovalRequired({ type: 'tool.approval_required', thread_id: 'main' }),
    false,
  );
  assert.equal(
    isApprovalRequired({ type: 'tool.approval_required', thread_id: '', tool_calls: [] }),
    false,
  );
  assert.equal(
    isApprovalRequired({ type: 'tool.approval_required', thread_id: 'main', tool_calls: [{}] }),
    false,
  );
});

test('ignores every other event type', () => {
  assert.equal(isApprovalRequired({ type: 'model.message.delta', content: 'x' }), false);
});

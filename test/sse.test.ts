import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSse } from '../src/trueforge/sse.ts';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const frame of parseSse(stream)) out.push(frame);
  return out;
}

test('parses a single frame', async () => {
  const frames = await collect(streamOf('data: {"type":"a"}\n\n'));
  assert.deepEqual(frames, [{ data: '{"type":"a"}' }]);
});

test('reassembles a frame split across chunk boundaries', async () => {
  // This is the case a naive split() drops, and the one that would lose an
  // approval prompt mid-call.
  const frames = await collect(streamOf('data: {"ty', 'pe":"appro', 'val"}\n\n'));
  assert.deepEqual(frames, [{ data: '{"type":"approval"}' }]);
});

test('joins repeated data lines with newlines', async () => {
  const frames = await collect(streamOf('data: one\ndata: two\n\n'));
  assert.equal(frames[0]?.data, 'one\ntwo');
});

test('keeps event and id fields', async () => {
  const frames = await collect(streamOf('event: tick\nid: 7\ndata: x\n\n'));
  assert.deepEqual(frames[0], { data: 'x', event: 'tick', id: '7' });
});

test('ignores comment lines', async () => {
  const frames = await collect(streamOf(': keepalive\ndata: real\n\n'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.data, 'real');
});

test('handles CRLF line endings', async () => {
  const frames = await collect(streamOf('data: x\r\n\r\n'));
  assert.equal(frames[0]?.data, 'x');
});

test('emits a trailing frame that has no blank line after it', async () => {
  const frames = await collect(streamOf('data: last'));
  assert.equal(frames[0]?.data, 'last');
});

test('drops frames that carry no data field', async () => {
  const frames = await collect(streamOf('event: ping\n\ndata: real\n\n'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.data, 'real');
});

test('frames a stream that uses lone carriage returns', async () => {
  // The SSE spec allows CR, LF and CRLF. Normalising only CRLF silently
  // loses every frame on a CR-only stream. Found by Qodo on PR 1.
  const frames = await collect(streamOf('data: one\r\rdata: two\r\r'));
  assert.deepEqual(frames.map((f) => f.data), ['one', 'two']);
});

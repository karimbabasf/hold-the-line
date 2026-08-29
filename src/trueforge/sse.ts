/**
 * Minimal Server-Sent Events parser.
 *
 * Written by hand rather than pulled from a dependency because the failure we
 * care about is subtle: an event can be split across chunk boundaries, and a
 * naive `chunk.split('\n\n')` silently drops the tail of every partial frame.
 * On a phone call that means a dropped approval prompt, so this keeps a buffer.
 */

export interface SseFrame {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Incrementally decodes SSE frames from a byte stream.
 *
 * Per the spec, frames are separated by a blank line, `:` starts a comment,
 * and repeated `data:` lines within one frame are joined with newlines.
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // The SSE spec allows CRLF, LF and a LONE CR as line terminators.
      // Normalising only CRLF loses every frame on a CR-only stream, so both
      // are folded to LF before the delimiter search.
      buffer = buffer.replace(/\r\n?/g, '\n');

      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const frame = decodeFrame(raw);
        if (frame) yield frame;
        sep = buffer.indexOf('\n\n');
      }
    }

    // A stream that ends without a trailing blank line still owes us its
    // last frame.
    const tail = decodeFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function decodeFrame(raw: string): SseFrame | null {
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // One optional leading space after the colon is part of the delimiter,
    // not the value.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }

  if (dataLines.length === 0) return null;
  const frame: SseFrame = { data: dataLines.join('\n') };
  if (event !== undefined) frame.event = event;
  if (id !== undefined) frame.id = id;
  return frame;
}

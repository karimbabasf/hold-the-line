/**
 * An OpenAI-shaped `/v1/chat/completions` endpoint backed by the agent harness.
 *
 * Telnyx AI Assistant already owns speech to text, text to speech and turn
 * taking, and it drives all of that by calling an external LLM over the
 * OpenAI chat protocol. So the entire telephony integration is this one
 * endpoint: it speaks OpenAI on the outside and TrueForge on the inside.
 *
 * Nothing here decides anything. It is a translator, deliberately, because
 * every decision the caller hears has to come from the harness so the
 * approval gate cannot be bypassed by putting logic on this side.
 */

/** A chunk of agent output on its way to the caller's ear. */
export interface TurnDelta {
  type: 'message.delta';
  text: string;
}

export interface ChatEndpointDeps {
  /** Runs one caller utterance through the harness and streams back text. */
  runTurn: (userText: string, callerId: string) => AsyncIterable<TurnDelta>;
}

interface ChatMessage {
  role: string;
  content: unknown;
}

const MODEL_NAME = 'hold-the-line';

export function createChatEndpoint(
  deps: ChatEndpointDeps,
): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405);
    }

    let body: { messages?: ChatMessage[]; user?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'body was not valid JSON' }, 400);
    }

    const userText = lastUserText(body.messages ?? []);
    if (userText === null) {
      return json({ error: 'no user message in the request' }, 400);
    }

    // Telnyx passes the caller identity through; without it a resumed call
    // cannot be matched to its checkpoint, so it degrades rather than throws.
    const callerId = typeof body.user === 'string' ? body.user : 'unknown';

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (s: string) => controller.enqueue(encoder.encode(s));
        try {
          for await (const delta of deps.runTurn(userText, callerId)) {
            if (delta.type === 'message.delta' && delta.text) {
              send(chunk({ content: delta.text }));
            }
          }
          send(chunk({}, 'stop'));
        } catch (err) {
          // A thrown error mid-stream cannot become an HTTP status, the
          // headers are long gone. Say something rather than leaving a
          // caller listening to silence.
          send(
            chunk({
              content:
                ' Sorry, something went wrong on my end. Let me get a person for you.',
            }),
          );
          send(chunk({}, 'stop'));
          console.error('runTurn failed mid-stream:', err);
        } finally {
          send('data: [DONE]\n\n');
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  };
}

function chunk(
  delta: { content?: string },
  finishReason: string | null = null,
): string {
  const payload = {
    id: 'chatcmpl-htl',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_NAME,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Returns the text of the last user message.
 *
 * Content may be a plain string or the array-of-parts form, and Telnyx has
 * been observed sending both, so both are handled rather than assumed.
 */
function lastUserText(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;

    if (typeof m.content === 'string') return m.content;

    if (Array.isArray(m.content)) {
      const text = m.content
        .map((part) =>
          part && typeof part === 'object' && 'text' in part
            ? String((part as { text: unknown }).text)
            : '',
        )
        .join('')
        .trim();
      if (text) return text;
    }
  }
  return null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

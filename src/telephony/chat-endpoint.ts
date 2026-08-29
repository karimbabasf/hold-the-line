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
  /**
   * Runs one caller utterance through the harness and streams back text.
   *
   * `signal` aborts when the caller is gone. A turn parked on an approval is
   * waiting on a promise only an operator settles, so without this it waits
   * for a caller who has already hung up: the waiter leaks and the console
   * keeps showing a gate for a call that ended.
   */
  runTurn: (
    userText: string,
    callerId: string,
    signal?: AbortSignal,
  ) => AsyncIterable<TurnDelta>;

  /**
   * The caller's socket went away. This is the end of the call.
   *
   * There is no disconnect webhook on this path: Telnyx holds one request per
   * turn and hangs up by stopping reading, so the only honest end-of-call
   * signal this process ever gets is the request being aborted or the
   * response stream being cancelled. Both are here and nowhere else. In
   * particular the abort at the natural end of a turn does NOT come through
   * here, because a finished turn is not a finished call, and a console told
   * otherwise would blank the screen between two sentences.
   *
   * Called at most once per request.
   */
  onCallerGone?: (callerId: string) => void;
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

    // The caller is gone when either the request is aborted or the response
    // body is cancelled. Telnyx does the second: it stops reading. Both are
    // funnelled into one signal so a turn has a single thing to listen to.
    const hangup = new AbortController();
    const giveUp = (why: string) => {
      if (!hangup.signal.aborted) hangup.abort(new Error(why));
    };

    // The caller is GONE, as opposed to the turn merely being over. Latched,
    // because both paths below can fire for one hangup and the call only ends
    // once.
    let announcedGone = false;
    const callerGone = (why: string) => {
      giveUp(why);
      if (announcedGone) return;
      announcedGone = true;
      deps.onCallerGone?.(callerId);
    };

    if (req.signal.aborted) {
      // 499 rather than 200: nothing was streamed, so this can still be a
      // status, and opening a harness turn for a caller who has already gone
      // costs a session and a model call for nobody.
      callerGone('caller hung up before the turn started');
      return json({ error: 'caller hung up before the turn started' }, 499);
    }
    req.signal.addEventListener('abort', () => callerGone('request aborted'));

    // Set once the stream is gone, so the rest of a turn that is still
    // unwinding does not throw trying to speak into it.
    let shut = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (s: string) => {
          if (shut) return;
          try {
            controller.enqueue(encoder.encode(s));
          } catch {
            shut = true;
          }
        };
        try {
          for await (const delta of deps.runTurn(userText, callerId, hangup.signal)) {
            if (delta.type === 'message.delta' && delta.text) {
              send(chunk({ content: delta.text }));
            }
          }
          send(chunk({}, 'stop'));
        } catch (err) {
          if (hangup.signal.aborted) {
            // The caller is gone, so the turn being cut short is the point,
            // not a fault. Apologising into a dead line and logging it as a
            // failure would make every hangup look like an outage.
            console.log(`turn ended early: ${callerId} hung up`);
          } else {
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
          }
        } finally {
          send('data: [DONE]\n\n');
          if (!shut) {
            shut = true;
            try {
              controller.close();
            } catch {
              // Already closed by a cancel. Nothing to do.
            }
          }
          // The turn is over either way, so nothing should still be waiting
          // on its behalf.
          giveUp('turn finished');
        }
      },
      cancel(reason) {
        // The consumer stopped reading. On a phone line that is the call
        // ending mid-sentence, and it is the signal that actually arrives:
        // the socket close is noticed by the server, which cancels this
        // stream. See server.ts.
        shut = true;
        callerGone(`response cancelled: ${String(reason ?? 'no reason given')}`);
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

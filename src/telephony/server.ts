/**
 * The process Telnyx talks to.
 *
 * Entrypoint only. All behaviour lives in `chat-endpoint.ts` and
 * `harness-bridge.ts` so it can be tested without binding a port.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { TrueForgeClient } from '../trueforge/client.ts';
import { createChatEndpoint } from './chat-endpoint.ts';
import { createBridge } from './harness-bridge.ts';

/**
 * The endpoint is on a public tunnel, so it authenticates.
 *
 * Without this, the `user` field in the body is an unauthenticated session
 * key: anyone who finds the tunnel can pass another caller's number and
 * resume their claim session, reading everything already computed on it.
 * Telnyx sends this as a bearer token from its integration secret.
 */
const SHARED_SECRET = process.env.TELEPHONY_SHARED_SECRET;
if (!SHARED_SECRET) {
  console.error('TELEPHONY_SHARED_SECRET is not set. Refusing to serve an unauthenticated endpoint.');
  process.exit(1);
}

/** One caller utterance is a few hundred bytes. 64KB is generous and stops a
 *  single request eating memory on a public listener. */
const MAX_BODY_BYTES = 64 * 1024;

const PORT = Number(process.env.PORT ?? 8791);
const AGENT_NAME = process.env.TRUEFORGE_AGENT ?? 'northvane';
const TRUEFORGE_BASE_URL = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';

const bridge = createBridge({
  forge: new TrueForgeClient({ baseUrl: TRUEFORGE_BASE_URL }),
  agentName: AGENT_NAME,
  onApprovalRequired: (toolCalls) => {
    console.log('[gate] approval required:', JSON.stringify(toolCalls));
  },
});

const chat = createChatEndpoint({ runTurn: bridge.runTurn });

function toRequest(req: IncomingMessage, body: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
  }
  return new Request(`http://localhost:${PORT}${req.url ?? '/'}`, {
    method: req.method ?? 'GET',
    headers,
    ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body }),
  });
}

/** Constant-time compare so a wrong token cannot be found byte by byte. */
function secretMatches(header: string | undefined): boolean {
  const presented = header?.replace(/^Bearer /i, '') ?? '';
  const expected = SHARED_SECRET as string;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, and the length itself is not
  // worth hiding here, so it is checked first.
  return a.length === b.length && timingSafeEqual(a, b);
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  let received = 0;
  let tooLarge = false;

  req.on('data', (c: Buffer) => {
    received += c.length;
    if (received > MAX_BODY_BYTES) {
      if (!tooLarge) {
        tooLarge = true;
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'request body too large' }));
        req.destroy();
      }
      return;
    }
    chunks.push(c);
  });

  req.on('end', () => {
    if (tooLarge) return;
    void (async () => {
      const url = req.url ?? '/';
      console.log(`${req.method} ${url}`);

      if (url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, agent: AGENT_NAME }));
        return;
      }

      if (!url.startsWith('/v1/chat/completions')) {
        res.writeHead(404).end('not found');
        return;
      }

      if (!secretMatches(req.headers.authorization)) {
        console.warn('rejected an unauthenticated request');
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const response = await chat(toRequest(req, Buffer.concat(chunks).toString('utf8')));

      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) {
        res.end();
        return;
      }
      for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(piece);
      }
      res.end();
    })();
  });
});

server.listen(PORT, () => {
  console.log(`hold-the-line telephony on http://localhost:${PORT}`);
  console.log(`  harness: ${TRUEFORGE_BASE_URL}  agent: ${AGENT_NAME}`);
});

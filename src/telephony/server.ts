/**
 * The process Telnyx talks to.
 *
 * Entrypoint only. All behaviour lives in `chat-endpoint.ts` and
 * `harness-bridge.ts` so it can be tested without binding a port.
 */

import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeSSE, type ConsoleEvent } from '../console/events.ts';
import { TrueForgeClient } from '../trueforge/client.ts';
import type { ApprovalDecision, ResolvedGate } from '../trueforge/types.ts';
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

const CONSOLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'console');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const PORT = Number(process.env.PORT ?? 8791);
const AGENT_NAME = process.env.TRUEFORGE_AGENT ?? 'northvane';
const TRUEFORGE_BASE_URL = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';

const sseClients = new Set<ServerResponse>();
let sseSeq = 0;

function broadcast(event: ConsoleEvent): void {
  const frame = encodeSSE(event, sseSeq++);
  for (const client of sseClients) {
    client.write(frame);
  }
}

let currentCallStart = Date.now();

/**
 * Gates the bridge is holding, and the promises waiting on them.
 *
 * The bridge stops speaking the moment a gate opens and resumes only when a
 * decision arrives, so this map is the release. It lives here rather than in
 * the console because the console is a browser page: the decision has to
 * reach the process that holds the caller's stream.
 */
const pendingGates = new Map<string, ResolvedGate>();
const waiting = new Map<string, (d: ApprovalDecision | null) => void>();

/** Settles one held gate. Returns false when nothing was waiting on it, so a
 *  replayed or stale decision cannot look like it worked. */
function decideGate(id: string, decision: ApprovalDecision | null): boolean {
  const settle = waiting.get(id);
  if (!settle) return false;
  waiting.delete(id);
  pendingGates.delete(id);
  settle(decision);
  return true;
}

const bridge = createBridge({
  forge: new TrueForgeClient({ baseUrl: TRUEFORGE_BASE_URL }),
  agentName: AGENT_NAME,
  onApprovalRequired: (gate, _callerId) => {
    console.log(`[gate] approval required: ${gate.tool} ${gate.tool_call_id}`);
    pendingGates.set(gate.tool_call_id, gate);
    broadcast({
      type: 'gate',
      t: Date.now() - currentCallStart,
      id: gate.tool_call_id,
      tool: gate.tool,
      status: 'opened',
      ...(gate.utterance === undefined ? {} : { wanted: gate.utterance }),
      ...(gate.claim_id === undefined ? {} : { claim_id: gate.claim_id }),
      ...(gate.authorised_amounts === undefined
        ? {}
        : { authorised_amounts: gate.authorised_amounts }),
    } satisfies ConsoleEvent);
  },
  awaitApproval: (gate, callerId, signal) =>
    new Promise<ApprovalDecision | null>((settle) => {
      // Held until a human posts to /gate/decide. There is no timer here on
      // purpose: an operator who never decides leaves the caller hearing
      // nothing, which is the outcome this product exists to guarantee.
      waiting.set(gate.tool_call_id, settle);

      // A hangup is not a decision, so this settles null, the same as an
      // operator who never answered: nothing more is spoken. What it does
      // change is that the waiter stops existing and the console stops
      // showing a gate for a call that ended. Without it the promise is
      // never settled at all and the entry never leaves the map.
      if (!signal) return;
      const gone = () => {
        if (!waiting.has(gate.tool_call_id)) return;
        console.log(`[gate] caller gone, dropping held gate ${gate.tool_call_id}`);
        decideGate(gate.tool_call_id, null);
        // The call ending is the truthful event here, not a new gate status:
        // the gate was neither approved nor sent back, there is simply no
        // longer a caller to say anything to.
        broadcast({
          type: 'call',
          t: Date.now() - currentCallStart,
          status: 'ended',
          caller: callerId,
        } satisfies ConsoleEvent);
      };
      if (signal.aborted) gone();
      else signal.addEventListener('abort', gone, { once: true });
    }),
  onConsoleEvent: (event) => {
    if (event.type === 'call' && event.status === 'started') {
      currentCallStart = Date.now();
    }
    broadcast(event);
  },
});

const chat = createChatEndpoint({ runTurn: bridge.runTurn });

/**
 * Wraps a Node request as a Fetch Request, carrying the hangup with it.
 *
 * `close` on the response with nothing finished is the socket going away,
 * which on a phone line is the call ending mid-sentence. The endpoint reads
 * that off `req.signal` to refuse a turn for a caller who is already gone.
 * It is not the only path: a Request's signal follows the controller passed
 * to it and stopped firing once the request object was no longer referenced,
 * so the dispatch below also cancels the response reader, which is what
 * reliably reaches a turn already in flight.
 */
function toRequest(req: IncomingMessage, res: ServerResponse, body: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
  }
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) gone.abort(new Error('client closed the connection'));
  });
  return new Request(`http://localhost:${PORT}${req.url ?? '/'}`, {
    method: req.method ?? 'GET',
    headers,
    signal: gone.signal,
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

      if (url === '/sse') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        });
        sseClients.add(res);
        req.on('close', () => { sseClients.delete(res); });
        return;
      }

      // The operator console, served straight from source.
      //
      // Browsers cannot run TypeScript, so the .ts modules have their types
      // stripped on the way out rather than built ahead of time. A build step
      // is one more thing to forget on the morning of a demo, and there is
      // nothing here that needs bundling.
      if (url === '/console' || url.startsWith('/console/')) {
        const rel = url === '/console' ? 'index.html' : url.slice('/console/'.length);
        // Reject anything that climbs out of the console directory.
        const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
        const file = join(CONSOLE_DIR, safe);
        if (!file.startsWith(CONSOLE_DIR)) {
          res.writeHead(403).end('forbidden');
          return;
        }
        try {
          const ext = extname(file);
          if (ext === '.ts') {
            const src = await readFile(file, 'utf8');
            res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
            // Import specifiers keep their .ts extension in source; the
            // browser has to ask for the same paths this route serves.
            res.end(stripTypeScriptTypes(src, { mode: 'strip' }));
            return;
          }
          const body = await readFile(file);
          res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
          res.end(body);
          return;
        } catch {
          res.writeHead(404).end('not found');
          return;
        }
      }

      if (url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, agent: AGENT_NAME }));
        return;
      }

      // The release for a held gate. Authenticated with the same shared
      // secret as the chat endpoint: whoever can reach this can decide what
      // a caller hears, so it is not left open on a public tunnel.
      if (url === '/gate/pending' || url === '/gate/decide') {
        if (!secretMatches(req.headers.authorization)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        if (url === '/gate/pending' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([...pendingGates.values()]));
          return;
        }

        if (url === '/gate/decide' && req.method === 'POST') {
          let body: { id?: unknown; status?: unknown; reason?: unknown };
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'body was not valid JSON' }));
            return;
          }
          // Only these two words settle a gate. Anything else, including a
          // missing status, is not a decision and releases nothing.
          const allowed = body.status === 'allow';
          const denied = body.status === 'deny';
          if (typeof body.id !== 'string' || (!allowed && !denied)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ error: 'expected {id, status: "allow" | "deny", reason?}' }),
            );
            return;
          }
          const decision: ApprovalDecision = allowed
            ? { status: 'allow' }
            : {
                status: 'deny',
                ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
              };
          const settled = decideGate(body.id, decision);
          res.writeHead(settled ? 200 : 404, { 'content-type': 'application/json' });
          res.end(JSON.stringify(settled ? { ok: true } : { error: 'no gate is waiting on that id' }));
          return;
        }

        res.writeHead(405).end('method not allowed');
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

      const response = await chat(
        toRequest(req, res, Buffer.concat(chunks).toString('utf8')),
      );

      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) {
        res.end();
        return;
      }
      // Read rather than for-await, so a socket that has gone away stops the
      // loop and cancels the stream instead of writing into nothing for the
      // rest of the turn.
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      // Cancelling the reader is what actually reaches the turn. The signal on
      // the Request is a follower of the controller above and does not
      // reliably fire once the request object is no longer referenced, which
      // showed up live as a gate that stayed held after the caller hung up.
      // This path is direct: socket closed, stream cancelled, turn told.
      res.on('close', () => {
        if (!res.writableFinished) {
          void reader.cancel(new Error('client closed the connection')).catch(() => {});
        }
      });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (res.writableEnded || res.destroyed) break;
          res.write(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!res.writableEnded && !res.destroyed) res.end();
    })();
  });
});

server.listen(PORT, () => {
  console.log(`hold-the-line telephony on http://localhost:${PORT}`);
  console.log(`  harness: ${TRUEFORGE_BASE_URL}  agent: ${AGENT_NAME}`);
});

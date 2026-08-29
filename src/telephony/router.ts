/**
 * Every route the telephony process answers, as a function.
 *
 * This used to be the body of `createServer`'s callback in `server.ts`, which
 * meant no test could reach it without binding a port, and so nothing did.
 * That is how `/console?demo` came to 404 for every documented console mode:
 * the route compared `req.url`, which carries the query string. A live probe
 * on a spare port found it. A test should have.
 *
 * The two interfaces below are deliberately smaller than Node's
 * `IncomingMessage` and `ServerResponse`: a test builds them as plain objects,
 * and `server.ts` adapts the real ones onto them at the one place a socket
 * actually exists.
 */

import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, normalize } from 'node:path';

/** One request, with its body already read. */
export interface RouteRequest {
  method: string;
  /** The raw request target, query string included. */
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
  /**
   * Registers a callback for the client going away. SSE uses it to drop a
   * client that closed the tab.
   *
   * This is the RESPONSE closing, never the request. Once a request body has
   * been read to its end, Node emits `close` on the IncomingMessage right
   * away, whether or not the client is still there. Wiring an SSE detach to
   * that dropped every console client about 15ms after it connected, and is
   * why a local `/sse` produced 0 bytes across a whole live call.
   */
  onClose(fn: () => void): void;

  /**
   * Registers a callback for the socket closing BEFORE the response finished.
   *
   * On a phone line that is the call ending mid-sentence, which is a
   * different event from `onClose` and has to be, because `onClose` also
   * fires on an orderly finish. A caller who hung up has to reach a turn that
   * is still running, so a gate held for them is dropped rather than left
   * waiting on somebody who is gone.
   *
   * A listener registered after the socket has already gone is called
   * straight away. The chat route registers one after awaiting the harness,
   * and a caller who hung up during that await would otherwise never reach
   * the reader that is about to start.
   */
  onAborted(fn: () => void): void;
}

/** The write side of one response. Held open for the lifetime of an SSE
 *  stream, so this is also the identity the SSE hub keys a client on. */
export interface RouteResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  write(chunk: string | Uint8Array): void;
  end(chunk?: string | Uint8Array): void;
  /** False once the response is finished or its socket is gone. The chat
   *  route reads it every chunk so a dead socket stops the stream rather
   *  than being written into for the rest of the turn. */
  writable(): boolean;
}

export interface RouterDeps {
  /** The OpenAI-shaped chat endpoint the caller's words go through. */
  chat(request: Request): Promise<Response>;
  /** True when the Authorization header presents the shared secret. */
  secretMatches(header: string | undefined): boolean;
  /** Directory the operator console is served from. */
  consoleDir: string;
  agentName: string;
  sse: {
    attach(sink: RouteResponse, lastEventId?: string | undefined): void;
    detach(sink: RouteResponse): void;
  };
  /**
   * The release for a held gate: what is pending, and one decision on one of
   * them. Both carry the same shared secret as the chat endpoint, because
   * whoever can reach them decides what a caller hears and this listener is
   * on a public tunnel.
   */
  gate?: {
    pending(): unknown;
    decide(body: string): Promise<{ status: number; body: unknown }>;
  };
  /** Accepts one batch of console events from another local process.
   *  Absent until the reporting channel is wired; the route 404s without it. */
  ingest?: (
    authorization: string | undefined,
    body: string,
  ) => { status: number; body: unknown };
  /**
   * The Telnyx TeXML status callback: the call was answered, or it ended.
   *
   * Authenticated on a query token rather than a header, because Telnyx
   * sends this one itself and there is nowhere to configure an Authorization
   * header for it. The token is the same shared secret, and it is only ever
   * in a URL we hand to Telnyx.
   */
  telnyxStatus?: (body: string) => { status: number; body: unknown };
  /** Origin used to rebuild a Web Standard Request. Only the path and query
   *  matter downstream; this exists so the URL parses. */
  origin?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function toWebRequest(req: RouteRequest, origin: string, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
  }
  const method = req.method || 'GET';
  return new Request(`${origin}${req.url || '/'}`, {
    method,
    headers,
    signal,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: req.body }),
  });
}

/**
 * The request line, with anything secret taken out of it.
 *
 * The Telnyx status callback authenticates on a query token, because Telnyx
 * sends it and there is nowhere to put a header. The request log wrote the
 * whole target, so every callback put the shared secret in plain text in
 * `.run/telephony.log`, where it survives long after the call does. The
 * query is still logged, because `/console?demo` and `?until=` are worth
 * seeing; the values that decide what a caller hears are not.
 */
const SECRET_PARAMS = new Set(['k', 'token', 'secret']);

export function redactQuery(url: string): string {
  const [path, query] = url.split('?');
  if (query === undefined) return url;
  const params = new URLSearchParams(query);
  let touched = false;
  for (const name of params.keys()) {
    if (!SECRET_PARAMS.has(name.toLowerCase())) continue;
    params.set(name, 'REDACTED');
    touched = true;
  }
  return touched ? `${path}?${params.toString()}` : url;
}

function sendJson(res: RouteResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createRouter(deps: RouterDeps) {
  const origin = deps.origin ?? 'http://localhost';

  async function serveConsole(res: RouteResponse, path: string): Promise<void> {
    const rel = path === '/console' ? 'index.html' : path.slice('/console/'.length);
    // Reject anything that climbs out of the console directory.
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const file = join(deps.consoleDir, safe);
    if (!file.startsWith(deps.consoleDir)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    try {
      const ext = extname(file);
      if (ext === '.ts') {
        // Browsers cannot run TypeScript, so the .ts modules have their types
        // stripped on the way out rather than built ahead of time. A build
        // step is one more thing to forget on the morning of a demo, and
        // there is nothing here that needs bundling. Import specifiers keep
        // their .ts extension in source; the browser asks for the same paths
        // this route serves.
        const src = await readFile(file, 'utf8');
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(stripTypeScriptTypes(src, { mode: 'strip' }));
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }

  return async function handle(req: RouteRequest, res: RouteResponse): Promise<void> {
    // Route on the path alone. The request target carries the query string,
    // so comparing it directly sent every documented console mode
    // (?demo, ?speed, ?until, ?live) down the 404 branch.
    const path = (req.url || '/').split('?')[0] ?? '/';

    if (path === '/sse') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        // Nothing between here and the browser should buffer an event stream.
        'x-accel-buffering': 'no',
      });
      // An SSE comment, which every client ignores, sent to push the response
      // head out now. Node holds the head until the first body write, so
      // without this a client that connects between events sits with a
      // pending request and no headers until something happens on the call.
      res.write(': connected\n\n');
      deps.sse.attach(res, req.headers['last-event-id']);
      req.onClose(() => { deps.sse.detach(res); });
      return;
    }

    if (path === '/ingest') {
      if (!deps.ingest || req.method !== 'POST') {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const result = deps.ingest(req.headers['authorization'], req.body);
      sendJson(res, result.status, result.body);
      return;
    }

    if (path === '/telnyx/status') {
      if (!deps.telnyxStatus || req.method !== 'POST') {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const token = new URLSearchParams((req.url || '').split('?')[1] ?? '').get('k');
      if (!deps.secretMatches(token ?? undefined)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const result = deps.telnyxStatus(req.body);
      sendJson(res, result.status, result.body);
      return;
    }

    if (path === '/gate/pending' || path === '/gate/decide') {
      if (!deps.gate) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      if (!deps.secretMatches(req.headers['authorization'])) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (path === '/gate/pending' && req.method === 'GET') {
        sendJson(res, 200, deps.gate.pending());
        return;
      }
      if (path === '/gate/decide' && req.method === 'POST') {
        const result = await deps.gate.decide(req.body);
        sendJson(res, result.status, result.body);
        return;
      }
      res.writeHead(405);
      res.end('method not allowed');
      return;
    }

    if (path === '/console' || path.startsWith('/console/')) {
      await serveConsole(res, path);
      return;
    }

    if (path === '/health') {
      sendJson(res, 200, { ok: true, agent: deps.agentName });
      return;
    }

    if (path !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    if (!deps.secretMatches(req.headers['authorization'])) {
      console.warn('rejected an unauthenticated request');
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    // The caller hanging up has to reach the turn, by two separate paths.
    //
    // The signal on the Request is one of them, and it is not the reliable
    // one: a Request's signal follows the controller passed to it and stopped
    // firing once the request object was no longer referenced. That showed up
    // live as a gate that stayed held after the caller had gone. The path
    // that actually reaches a turn in flight is cancelling the response
    // reader, below. Both are here because they fail differently, and the
    // endpoint uses the signal to refuse a turn for a caller already gone.
    const gone = new AbortController();
    req.onAborted(() => { gone.abort(new Error('client closed the connection')); });

    const response = await deps.chat(toWebRequest(req, origin, gone.signal));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) {
      res.end();
      return;
    }

    // Read rather than for-await, so a socket that has gone away stops the
    // loop and cancels the stream instead of writing into nothing for the
    // rest of the turn. Do not simplify this back.
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    req.onAborted(() => {
      void reader.cancel(new Error('client closed the connection')).catch(() => undefined);
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writable()) break;
        res.write(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (res.writable()) res.end();
  };
}

/**
 * Adapts Node's `(req, res)` onto the router.
 *
 * The one place a socket exists. Reads the body under a cap, flattens the
 * headers, and wires the SSE detach to the RESPONSE closing rather than the
 * request, for the reason on `RouteRequest.onClose`.
 */
export function createNodeHandler(options: {
  handle: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  maxBodyBytes: number;
  onRequest?: (method: string, url: string) => void;
}) {
  return function nodeHandler(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let received = 0;
    let tooLarge = false;

    req.on('data', (c: Buffer) => {
      received += c.length;
      if (received > options.maxBodyBytes) {
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
      const raw = req.url ?? '/';
      options.onRequest?.(req.method ?? 'GET', raw);

      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
      }

      // The socket closing before the response finished is the caller
      // hanging up. Latched, because a listener registered after that has
      // already happened still has to run: the chat route adds one after
      // awaiting the harness, and a caller who hung up during that await
      // would otherwise never reach the reader about to start.
      let aborted = false;
      const abortListeners: Array<() => void> = [];
      res.on('close', () => {
        if (res.writableFinished) return;
        aborted = true;
        for (const fn of abortListeners.splice(0)) fn();
      });

      // One sink object per request, so its identity is stable: the SSE hub
      // keys a live client on it.
      const sink: RouteResponse = {
        writeHead: (status, h) => { res.writeHead(status, h ?? {}); },
        write: (chunk) => { res.write(chunk); },
        end: (chunk) => { chunk === undefined ? res.end() : res.end(chunk); },
        writable: () => !res.writableEnded && !res.destroyed,
      };

      void options
        .handle(
          {
            method: req.method ?? 'GET',
            url: raw,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
            onClose: (fn) => { res.on('close', fn); },
            onAborted: (fn) => { if (aborted) fn(); else abortListeners.push(fn); },
          },
          sink,
        )
        .catch((err: unknown) => {
          console.error('request handling failed:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal error' }));
            return;
          }
          res.destroy();
        });
    });
  };
}

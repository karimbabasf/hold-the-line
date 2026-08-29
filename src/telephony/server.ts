/**
 * The process Telnyx talks to.
 *
 * Entrypoint only. All behaviour lives in `chat-endpoint.ts` and
 * `harness-bridge.ts` so it can be tested without binding a port.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { TrueForgeClient } from '../trueforge/client.ts';
import { createChatEndpoint } from './chat-endpoint.ts';
import { createBridge } from './harness-bridge.ts';

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

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
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

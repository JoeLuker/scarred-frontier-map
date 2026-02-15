import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'http';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export default function mapBridgePlugin(): Plugin {
  const sseClients = new Set<ServerResponse>();
  let cachedState = '{"hexCount":0,"exploredCount":0,"hexes":[],"overlays":[]}';

  function broadcast(data: string): void {
    for (const client of sseClients) {
      client.write(`data: ${data}\n\n`);
    }
  }

  return {
    name: 'map-bridge',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];

        if (!url?.startsWith('/api/bridge')) {
          next();
          return;
        }

        // SSE endpoint — browsers connect here
        if (url === '/api/bridge/events' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          res.write(':connected\n\n');
          sseClients.add(res);

          console.log(`[MapBridge] SSE client connected (${sseClients.size} total)`);

          const heartbeat = setInterval(() => {
            res.write(':heartbeat\n\n');
          }, 30000);

          req.on('close', () => {
            sseClients.delete(res);
            clearInterval(heartbeat);
            console.log(`[MapBridge] SSE client disconnected (${sseClients.size} remaining)`);
          });
          return;
        }

        // Receive command, broadcast to all SSE clients
        if (url === '/api/bridge' && req.method === 'POST') {
          readBody(req)
            .then((body) => {
              broadcast(body);
              try {
                const parsed = JSON.parse(body) as { command?: string };
                console.log(
                  `[MapBridge] ${parsed.command ?? 'unknown'} → ${sseClients.size} client(s)`,
                );
              } catch {
                console.log(`[MapBridge] broadcast → ${sseClients.size} client(s)`);
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, clients: sseClients.size }));
            })
            .catch((err: unknown) => {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: String(err) }));
            });
          return;
        }

        // Return cached state snapshot
        if (url === '/api/bridge/state' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(cachedState);
          return;
        }

        // Browser pushes state snapshot
        if (url === '/api/bridge/state' && req.method === 'POST') {
          readBody(req)
            .then((body) => {
              cachedState = body;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            })
            .catch((err: unknown) => {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: String(err) }));
            });
          return;
        }

        next();
      });
    },
  };
}

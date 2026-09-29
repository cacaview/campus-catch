import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { RoomRegistry } from './lib/room-registry.js';
import { createIceConfig } from './lib/turn-credentials.js';

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(payload);
}

export function createRelayServer({
  host = '127.0.0.1',
  port = 8081,
  publicIp,
  turnSecret = process.env.TURN_SECRET,
  now = Date.now,
  maxPayloadBytes = 65536
} = {}) {
  const registry = new RoomRegistry({ now });
  const httpServer = createServer((request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      sendJson(response, 400, { error: 'Bad request' });
      return;
    }

    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    if (pathname === '/healthz') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (pathname === '/api/ice-config') {
      if (!turnSecret || !publicIp) {
        sendJson(response, 503, { error: 'TURN configuration unavailable' });
        return;
      }
      try {
        sendJson(response, 200, createIceConfig({ publicIp, sharedSecret: turnSecret, nowMs: now(), ttlSeconds: 3600 }));
      } catch {
        sendJson(response, 503, { error: 'TURN configuration unavailable' });
      }
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  });

  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
  httpServer.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, ws => {
      webSocketServer.emit('connection', ws, request);
    });
  });

  webSocketServer.on('connection', ws => {
    registry.onConnection(ws);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(1003, 'Text messages only');
        return;
      }
      let packet;
      try {
        packet = JSON.parse(data.toString('utf8'));
      } catch {
        ws.close(1007, 'Invalid JSON');
        return;
      }
      registry.handlePacket(ws, packet);
    });
    ws.on('close', () => registry.removeConnection(ws));
    ws.on('error', () => registry.removeConnection(ws));
  });

  let closing;
  return {
    httpServer,
    webSocketServer,
    listen() {
      if (httpServer.listening) return Promise.resolve(httpServer.address());
      return new Promise((resolve, reject) => {
        const onError = error => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve(httpServer.address());
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      });
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        for (const client of webSocketServer.clients) client.close(1001, 'Server shutting down');
        if (webSocketServer.clients.size) {
          await new Promise(resolve => {
            const timer = setTimeout(() => {
              for (const client of webSocketServer.clients) client.terminate();
              resolve();
            }, 1000);
            timer.unref?.();
            webSocketServer.once('close', () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
        if (httpServer.listening) {
          await new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
        }
        if (webSocketServer._state === WebSocketServer.CLOSING) {
          await new Promise(resolve => webSocketServer.once('close', resolve));
        }
      })();
      return closing;
    }
  };
}

export default createRelayServer;

if (import.meta.url === `file://${process.argv[1]}`) {
  const relay = createRelayServer({
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 8081),
    publicIp: process.env.PUBLIC_IP,
    turnSecret: process.env.TURN_SECRET
  });
  relay.listen().catch(error => {
    console.error('[relay] listen failed:', error.message);
    process.exitCode = 1;
  });
  const shutdown = async () => {
    await relay.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

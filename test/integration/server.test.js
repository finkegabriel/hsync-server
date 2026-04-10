import { describe, it, expect, beforeAll } from 'vitest';
import net from 'net';
import run from '../../index.js';

// Use high random ports to avoid conflicts
const EXT_PORT = 19876;
const INT_PORT = 19877;

function sendRawHttp(port, rawRequest) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
      socket.write(rawRequest);
    });

    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', reject);

    // Timeout after 5 seconds
    setTimeout(() => {
      socket.destroy();
      resolve(Buffer.concat(chunks).toString());
    }, 5000);
  });
}

function parseHttpResponse(raw) {
  const headerEnd = raw.indexOf('\r\n\r\n');
  const headerPart = raw.slice(0, headerEnd);
  const body = raw.slice(headerEnd + 4);
  const lines = headerPart.split('\r\n');
  const [, statusCode] = lines[0].split(' ');
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(':');
    if (colonIdx > 0) {
      const key = lines[i].slice(0, colonIdx).trim().toLowerCase();
      const value = lines[i].slice(colonIdx + 1).trim();
      headers[key] = value;
    }
  }
  return { statusCode: parseInt(statusCode, 10), headers, body };
}

describe('TCP server integration (index.js)', () => {
  beforeAll(async () => {
    await run({
      hsyncSecret: 'integration-test-secret',
      // Override auth to use our test secret directly
      auth: async (_client, _hostname, secret) => secret === 'integration-test-secret',
      hsyncBase: '_hs',
      port: EXT_PORT,
      unauthedNames: false,
      cookies: {
        password: 'integration-test-cookie-password-32ch',
        name: '_hs_inttest',
        isSecure: false,
        path: '/_hs',
      },
      http: {
        host: '127.0.0.1',
        port: INT_PORT,
      },
      cors: {
        credentials: true,
        origin: true,
      },
      swaggerOptions: {
        swagger: {
          info: { title: 'test', version: '0.0.1' },
          basePath: '/_hs',
        },
      },
      swaggerUiOptions: {
        routePrefix: '/_hs/documentation',
      },
    });
    // Give server time to bind
    await new Promise((r) => setTimeout(r, 200));
  });

  describe('HTTP routing via inject (no TCP loopback)', () => {
    it('should serve health check through raw TCP', async () => {
      const raw = await sendRawHttp(
        EXT_PORT,
        'GET /_hs/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      const res = parseHttpResponse(raw);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('ok');
    });

    it('should serve admin page through raw TCP', async () => {
      const raw = await sendRawHttp(
        EXT_PORT,
        'GET /_hs/admin HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      const res = parseHttpResponse(raw);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('hsyncConfig');
    });

    it('should handle POST requests with body', async () => {
      const body = JSON.stringify({ secret: 'integration-test-secret' });
      const raw = await sendRawHttp(
        EXT_PORT,
        `POST /_hs/auth HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
      );
      const res = parseHttpResponse(raw);
      expect(res.statusCode).toBe(200);
      const resBody = JSON.parse(res.body);
      expect(resBody.authed).toBe(true);
    });

    it('should reject invalid POST payload', async () => {
      const body = JSON.stringify({});
      const raw = await sendRawHttp(
        EXT_PORT,
        `POST /_hs/auth HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
      );
      const res = parseHttpResponse(raw);
      expect(res.statusCode).toBe(400);
    });

    it('should serve swagger docs', async () => {
      const raw = await sendRawHttp(
        EXT_PORT,
        'GET /_hs/documentation/json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      const res = parseHttpResponse(raw);
      expect(res.statusCode).toBe(200);
      const swaggerBody = JSON.parse(res.body);
      expect(swaggerBody.swagger).toBe('2.0');
    });

    it('should serve static files', async () => {
      const raw = await sendRawHttp(
        EXT_PORT,
        'GET /_hs/ui.js HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      const res = parseHttpResponse(raw);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('web request forwarding', () => {
    it('should return 502 when no MQTT client for hostname', async () => {
      const raw = await sendRawHttp(
        EXT_PORT,
        'GET /test HTTP/1.1\r\nHost: unknown.example.com\r\nConnection: close\r\n\r\n'
      );
      expect(raw).toContain('502');
    });
  });

  describe('socket management', () => {
    it('should handle multiple concurrent connections', async () => {
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          sendRawHttp(
            EXT_PORT,
            'GET /_hs/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
          )
        );
      }
      const results = await Promise.all(promises);
      for (const raw of results) {
        const res = parseHttpResponse(raw);
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe('ok');
      }
    });

    it('should handle connection close gracefully', async () => {
      const socket = net.createConnection({ port: EXT_PORT, host: '127.0.0.1' });
      await new Promise((resolve) => socket.on('connect', resolve));
      socket.destroy();
      // Should not crash the server
      await new Promise((r) => setTimeout(r, 100));

      // Server still works
      const raw = await sendRawHttp(
        EXT_PORT,
        'GET /_hs/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      const res = parseHttpResponse(raw);
      expect(res.statusCode).toBe(200);
    });
  });
});

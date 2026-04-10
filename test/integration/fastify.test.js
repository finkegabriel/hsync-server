import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Joi from 'joi';

// Mock aedes so we don't start a real MQTT broker
vi.mock('../../aedes.js', () => ({
  launchAedes: vi.fn().mockReturnValue({
    handle: vi.fn(),
    close: vi.fn((cb) => cb && cb()),
    clients: {},
  }),
  rpcToClient: vi.fn().mockResolvedValue({ result: 'ok' }),
  peerRpcToClient: vi.fn().mockResolvedValue({ result: 'ok' }),
  peerNotifyToClient: vi.fn().mockResolvedValue('ok'),
}));

vi.mock('../../lib/auth.js', () => ({
  auth: vi.fn().mockResolvedValue(true),
  createDyn: vi.fn().mockResolvedValue({
    id: 'abc12345',
    secret: 'dyn-secret',
    url: 'abc12345.test.example.com',
    created: Date.now(),
    lastAccessed: Date.now(),
    timeout: 3600000,
  }),
  dyns: {},
}));

import startFastify from '../../fastify.js';

const config = {
  hsyncSecret: 'test-secret-for-fastify',
  hsyncBase: '_hs',
  port: 0, // unused in these tests
  serverBase: null,
  unauthedNames: false,
  cookies: {
    password: 'test-cookie-password-at-least-32-chars',
    name: '_hs_test',
    isSecure: false,
    path: '/_hs',
  },
  http: {
    host: '127.0.0.1',
    port: 0, // random port
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
};

describe('fastify server integration', () => {
  let fastify;

  beforeAll(async () => {
    const result = await startFastify(config);
    fastify = result.fastify;
  });

  afterAll(async () => {
    await fastify.close();
  });

  describe('server startup', () => {
    it('should have started successfully', () => {
      expect(fastify).toBeDefined();
      expect(fastify.server.listening).toBe(true);
    });
  });

  describe('core routes via inject', () => {
    it('GET /_hs/health returns ok', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/_hs/health' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('ok');
    });

    it('GET /_hs/admin returns rendered template', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/_hs/admin' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('hsyncConfig');
      expect(res.body).toContain('creds: false');
    });

    it('GET /_hs/me returns 401 without session', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/_hs/me' });
      expect(res.statusCode).toBe(401);
    });

    it('GET /_hs/logout returns ok', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/_hs/logout' });
      expect(res.statusCode).toBe(200);
    });

    it('POST /_hs/auth with valid secret returns authed user', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/_hs/auth',
        headers: { 'content-type': 'application/json' },
        payload: { secret: 'test-secret' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.authed).toBe(true);
      expect(body.hostName).toBeDefined();
    });

    it('POST /_hs/auth with toAdmin redirects', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/_hs/auth',
        headers: { 'content-type': 'application/json' },
        payload: { secret: 'test-secret', toAdmin: true },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/_hs/admin');
    });

    it('POST /_hs/auth rejects missing secret', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/_hs/auth',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /_hs/dyn returns dynamic hostname', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/_hs/dyn',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe('abc12345');
      expect(body.url).toContain('test.example.com');
    });

    it('POST /_hs/srpc validates payload', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/_hs/srpc',
        headers: { 'content-type': 'application/json' },
        payload: { method: 'ping', params: ['hello'] },
      });
      expect(res.statusCode).toBe(200);
    });

    it('POST /_hs/srpc rejects invalid payload', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/_hs/srpc',
        headers: { 'content-type': 'application/json' },
        payload: { wrong: 'shape' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /_hs/rpc accepts valid peer RPC', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/_hs/rpc',
        headers: { 'content-type': 'application/json' },
        payload: {
          msg: { method: 'test', params: [], jsonrpc: '2.0' },
          toHost: 'http://target.example.com',
          fromHost: 'http://source.example.com',
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('POST /_hs/message accepts valid message', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/_hs/message',
        headers: { 'content-type': 'application/json' },
        payload: { topic: 'test', payload: 'hello' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('static files', () => {
    it('should serve ui.js from public directory', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/_hs/ui.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('javascript');
    });

    it('should return 404 for nonexistent file', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/_hs/nonexistent-file-xyz.js' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('swagger', () => {
    it('should serve swagger JSON', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/_hs/documentation/json' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.swagger).toBe('2.0');
      expect(body.paths).toBeDefined();
    });

    it('should serve swagger UI', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/_hs/documentation/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });
  });

  describe('CORS', () => {
    it('should include CORS headers', async () => {
      const res = await fastify.inject({
        method: 'GET',
        url: '/_hs/health',
        headers: { origin: 'http://example.com' },
      });
      expect(res.headers['access-control-allow-origin']).toBeDefined();
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });
  });

  describe('error handling', () => {
    it('should return structured error for 404', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/nonexistent' });
      expect(res.statusCode).toBe(404);
    });
  });
});

describe('fastify httpExt integration', () => {
  let fastify;

  beforeAll(async () => {
    const extConfig = {
      ...config,
      http: { host: '127.0.0.1', port: 0 },
      httpExt: {
        routes: [
          {
            method: 'GET',
            path: '/custom',
            handler: () => 'custom-response',
            config: {
              description: 'A custom route',
              tags: ['api'],
            },
          },
          {
            method: 'POST',
            path: '/validated',
            handler: (request) => ({ received: request.body.name }),
            config: {
              validate: {
                payload: Joi.object({
                  name: Joi.string().required(),
                }),
              },
            },
          },
          {
            method: 'GET',
            path: '/protected',
            handler: (request) => ({ user: request.auth?.credentials }),
            config: {
              auth: {
                strategies: ['auth'],
                mode: 'required',
              },
            },
          },
          {
            method: 'GET',
            path: '/optional-auth',
            handler: (request) => ({
              authed: request.auth?.isAuthenticated || false,
            }),
            config: {
              auth: {
                strategies: ['auth'],
                mode: 'optional',
              },
            },
          },
        ],
      },
    };

    const result = await startFastify(extConfig);
    fastify = result.fastify;
  });

  afterAll(async () => {
    await fastify.close();
  });

  it('should register httpExt GET route at /_hs/x/custom', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/_hs/x/custom' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('custom-response');
  });

  it('should validate httpExt POST route', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/_hs/x/validated',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'test' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe('test');
  });

  it('should reject invalid payload on httpExt route', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/_hs/x/validated',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('should enforce auth on protected httpExt route', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/_hs/x/protected' });
    expect(res.statusCode).toBe(401);
  });

  it('should allow unauthenticated access to optional auth route', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/_hs/x/optional-auth' });
    expect(res.statusCode).toBe(200);
    expect(res.json().authed).toBe(false);
  });
});

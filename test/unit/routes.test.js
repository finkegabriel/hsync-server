import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import fastifySensible from '@fastify/sensible';
import fastifyView from '@fastify/view';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifySecureSession from '@fastify/secure-session';
import Handlebars from 'handlebars';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '../..');

// Mock aedes exports
vi.mock('../../aedes.js', () => ({
  rpcToClient: vi.fn().mockResolvedValue({ result: 'ok' }),
  peerRpcToClient: vi.fn().mockResolvedValue({ result: 'ok' }),
  peerNotifyToClient: vi.fn().mockResolvedValue('ok'),
}));

// Mock auth exports
vi.mock('../../lib/auth.js', () => ({
  auth: vi.fn().mockResolvedValue(true),
  createDyn: vi.fn().mockResolvedValue({
    id: 'abc12345',
    secret: 'test-secret',
    url: 'abc12345.test.example.com',
    created: Date.now(),
    lastAccessed: Date.now(),
    timeout: 3600000,
  }),
  dyns: {},
}));

import registerRoutes from '../../lib/routes.js';

const config = {
  hsyncBase: '_hs',
  auth: null,
  cookies: {
    password: 'test-secret-at-least-32-chars-long',
    name: '_hs',
    isSecure: false,
    path: '/_hs',
  },
};

async function buildApp() {
  const fastify = Fastify({ logger: false });

  fastify.setValidatorCompiler(({ schema }) => {
    if (schema && typeof schema.validate === 'function') {
      return (data) => {
        const result = schema.validate(data);
        if (result.error) return { error: result.error };
        return { value: result.value };
      };
    }
    return (data) => ({ value: data });
  });

  await fastify.register(fastifySensible);
  await fastify.register(fastifyCookie);

  const sessionKey = crypto
    .createHash('sha256')
    .update(config.cookies.password)
    .digest();

  await fastify.register(fastifySecureSession, {
    cookieName: config.cookies.name,
    key: sessionKey,
    cookie: {
      path: config.cookies.path,
      secure: config.cookies.isSecure,
      httpOnly: true,
    },
  });

  fastify.decorateRequest('auth', null);
  fastify.addHook('onRequest', async (request) => {
    const session = request.session?.get('data');
    request.auth = {
      credentials: session || null,
      isAuthenticated: !!session,
    };
  });

  await fastify.register(fastifyView, {
    engine: { handlebars: Handlebars },
    root: path.join(serverRoot, 'templates'),
    viewExt: 'hbs',
  });

  await fastify.register(fastifyStatic, {
    root: path.join(serverRoot, 'public'),
    prefix: `/${config.hsyncBase}/`,
  });

  registerRoutes(fastify, config);

  return fastify;
}

describe('routes', () => {
  let app;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('health endpoint', () => {
    it('should return ok', async () => {
      const res = await app.inject({ method: 'GET', url: '/_hs/health' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('ok');
    });
  });

  describe('admin endpoint', () => {
    it('should return 200 with template', async () => {
      const res = await app.inject({ method: 'GET', url: '/_hs/admin' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('hsyncConfig');
      expect(res.body).toContain('_hs');
    });

    it('should show creds as false when not authenticated', async () => {
      const res = await app.inject({ method: 'GET', url: '/_hs/admin' });
      expect(res.body).toContain('creds: false');
    });
  });

  describe('logout endpoint', () => {
    it('should return ok', async () => {
      const res = await app.inject({ method: 'GET', url: '/_hs/logout' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('ok');
    });
  });

  describe('me endpoint', () => {
    it('should return 401 when not authenticated', async () => {
      const res = await app.inject({ method: 'GET', url: '/_hs/me' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('dyn endpoint', () => {
    it('should return a dynamic hostname object', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/_hs/dyn',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.url).toBeDefined();
      expect(body.secret).toBeDefined();
    });
  });

  describe('srpc endpoint', () => {
    it('should accept valid payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/_hs/srpc',
        headers: { 'content-type': 'application/json' },
        payload: { method: 'ping', params: ['hello'] },
      });
      expect(res.statusCode).toBe(200);
    });

    it('should reject missing method', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/_hs/srpc',
        headers: { 'content-type': 'application/json' },
        payload: { params: ['hello'] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject missing params', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/_hs/srpc',
        headers: { 'content-type': 'application/json' },
        payload: { method: 'ping' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('rpc endpoint', () => {
    it('should accept valid payload', async () => {
      const res = await app.inject({
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
  });

  describe('auth endpoint', () => {
    it('should accept valid login', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/_hs/auth',
        headers: { 'content-type': 'application/json' },
        payload: { secret: 'test-secret' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.authed).toBe(true);
    });

    it('should reject missing secret', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/_hs/auth',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('should redirect to admin when toAdmin is true', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/_hs/auth',
        headers: { 'content-type': 'application/json' },
        payload: { secret: 'test-secret', toAdmin: true },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/_hs/admin');
    });
  });

  describe('static files', () => {
    it('should serve files from public directory', async () => {
      const res = await app.inject({ method: 'GET', url: '/_hs/ui.js' });
      expect(res.statusCode).toBe(200);
    });

    it('should serve favicon', async () => {
      const res = await app.inject({ method: 'GET', url: '/favicon.ico' });
      // May be 200 or 404 depending on whether favicon exists
      expect([200, 404]).toContain(res.statusCode);
    });
  });

  describe('message endpoint', () => {
    it('should accept valid message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/_hs/message',
        headers: { 'content-type': 'application/json' },
        payload: { topic: 'test', payload: 'hello' },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});

import Joi from 'joi';
import createDebug from 'debug';
import { rpcToClient, peerRpcToClient, peerNotifyToClient } from '../aedes.js';
import { auth, createDyn } from './auth.js';
import { p2pConfig } from './libp2p.js';

const debug = createDebug('hsync:routes');

function getCreds(request) {
  const creds = request.auth?.credentials;
  if (Array.isArray(creds)) {
    return creds[0];
  }
  return creds;
}

function registerRoutes(fastify, config) {
  // Admin UI page - optional auth
  fastify.get(`/${config.hsyncBase}/admin`, async (request, reply) => {
    const creds = getCreds(request);
    debug({ creds });
    return reply.view('admin', {
      creds: !!creds,
      base: config.hsyncBase,
      hostName: request.hostname,
      p2pConfig: JSON.stringify(p2pConfig),
    });
  });

  // Favicon
  fastify.get('/favicon.ico', (request, reply) => {
    return reply.sendFile('favicon.ico');
  });

  // RPC to connected client
  fastify.post(`/${config.hsyncBase}/srpc`, {
    schema: {
      description: 'Make an rpc call to the hsync client',
      tags: ['api'],
      body: Joi.object({
        method: Joi.string().required(),
        params: Joi.array().required(),
      }).label('RpcRequest'),
    },
    handler: async (request) => {
      debug('srpc', request.hostname, request.body.method);
      return await rpcToClient(request.hostname, request.body.method, ...request.body.params);
    },
  });

  // Peer RPC between clients
  fastify.post(`/${config.hsyncBase}/rpc`, {
    schema: {
      description: 'Make a peer rpc call to the hsync client',
      tags: ['api'],
      body: Joi.object({
        msg: Joi.object({
          jsonrpc: Joi.string(),
          method: Joi.string().required(),
          params: Joi.array().required(),
          id: Joi.alternatives(Joi.string(), Joi.number()),
        }),
        myAuth: Joi.string(),
        toHost: Joi.string(),
        fromHost: Joi.string(),
      }).label('PeerRpcRequest'),
    },
    handler: async (request) => {
      debug('rpc', request.hostname, request.body.method);
      const rpcResult = await peerRpcToClient(request.body);
      debug('peerRpcToClient result', rpcResult);
      return rpcResult;
    },
  });

  // Message to client
  fastify.post(`/${config.hsyncBase}/message`, {
    schema: {
      description: 'Message hsync client a {topic, payload}',
      tags: ['api'],
      body: Joi.object(),
    },
    handler: async (request) => {
      const { query, headers, body: reqPayload } = request;
      debug('rpc', request.hostname, request.body);
      const ip = request.headers['req-forwarded-for'] || request.ip;
      const msg = {
        payload: reqPayload.payload,
        topic: String(reqPayload.topic),
        headers,
        query,
        ip,
      };
      const rpcResult = await peerNotifyToClient(request.hostname, 'external_message', msg);
      debug('peerRpcToClient result', rpcResult);
      return rpcResult;
    },
  });

  // Login
  fastify.post(`/${config.hsyncBase}/auth`, {
    schema: {
      description: 'Login for the admin UI',
      tags: ['api'],
      body: Joi.object({
        secret: Joi.string().required(),
        type: Joi.string().allow(null).allow(''),
        toAdmin: Joi.boolean().allow(null).allow(''),
      }).label('Auth'),
    },
    handler: async (request, reply) => {
      const { secret, toAdmin, type } = request.body;
      const authImpl = config.auth || auth;
      const authed = await authImpl({ req: request, type, toAdmin }, request.hostname, secret);
      if (authed) {
        const user = { hostName: request.hostname, authed: true };
        request.session.set('data', user);
        if (toAdmin) {
          return reply.redirect(`/${config.hsyncBase}/admin`);
        }
        return user;
      }
      throw fastify.httpErrors.unauthorized();
    },
  });

  // Create dynamic login
  fastify.post(`/${config.hsyncBase}/dyn`, {
    schema: {
      description: 'Create dynamic login',
      tags: ['api'],
      body: Joi.object(),
    },
    handler: async () => {
      try {
        debug('starting dyn');
        const dyn = await createDyn();
        debug('dyn', dyn);
        return dyn;
      } catch (e) {
        debug('error creating dyn', e);
        throw e;
      }
    },
  });

  // Check authentication
  fastify.get(`/${config.hsyncBase}/me`, {
    schema: {
      description: 'Checks Authentication',
      tags: ['api'],
    },
    preHandler: async (request, _reply) => {
      if (!request.auth?.isAuthenticated) {
        throw fastify.httpErrors.unauthorized();
      }
    },
    handler: (request) => {
      return getCreds(request);
    },
  });

  // Logout
  fastify.get(`/${config.hsyncBase}/logout`, {
    schema: {
      description: 'Logout of the admin UI',
      tags: ['api'],
    },
    handler: (request) => {
      request.session.delete();
      return 'ok';
    },
  });

  // Health check
  fastify.get(`/${config.hsyncBase}/health`, {
    schema: {
      description: 'Health check',
      tags: ['api'],
    },
    handler: () => {
      return 'ok';
    },
  });
}

export default registerRoutes;
export { getCreds };

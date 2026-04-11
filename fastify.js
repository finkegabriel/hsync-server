import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import fastifyCookie from '@fastify/cookie';
import fastifySecureSession from '@fastify/secure-session';
import fastifyCors from '@fastify/cors';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifySensible from '@fastify/sensible';
import { WebSocketServer, createWebSocketStream } from 'ws';
import Handlebars from 'handlebars';
import createDebug from 'debug';

import { launchAedes } from './aedes.js';
import registerRoutes from './lib/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const debug = createDebug('hsync:http');
const debugError = createDebug('errors');

async function startFastify(config) {
  const fastify = Fastify({ logger: false });

  // Error handling
  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500;
    debugError('request error', statusCode, error.message);
    reply.status(statusCode).send({
      statusCode,
      error: error.name || 'Error',
      message: error.message,
    });
  });

  // Joi validator compiler
  fastify.setValidatorCompiler(({ schema }) => {
    if (schema && typeof schema.validate === 'function') {
      // Joi schema
      return (data) => {
        const result = schema.validate(data);
        if (result.error) {
          return { error: result.error };
        }
        return { value: result.value };
      };
    }
    // JSON Schema passthrough (for Fastify's internal schemas)
    return (data) => ({ value: data });
  });

  // CORS
  await fastify.register(fastifyCors, config.cors);

  // Sensible (httpErrors)
  await fastify.register(fastifySensible);

  // Cookie + secure session
  await fastify.register(fastifyCookie, {
    secret: config.cookies.password || 'hsync-default-cookie-secret',
  });

  // Generate a deterministic key from the cookie password
  const sessionKey = crypto
    .createHash('sha256')
    .update(config.cookies.password || 'hsync-default-secret-change-me')
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

  // Auth decoration — replicate Hapi's req.cookieAuth and req.auth
  fastify.decorateRequest('auth', null);
  fastify.addHook('onRequest', async (request) => {
    const session = request.session?.get('data');
    request.auth = {
      credentials: session || null,
      isAuthenticated: !!session,
    };
  });

  // Template rendering
  await fastify.register(fastifyView, {
    engine: { handlebars: Handlebars },
    root: path.join(__dirname, 'templates'),
    viewExt: 'hbs',
  });

  // Static files — main public directory
  await fastify.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: `/${config.hsyncBase}/`,
  });

  // Swagger
  await fastify.register(fastifySwagger, config.swaggerOptions);
  await fastify.register(fastifySwaggerUi, config.swaggerUiOptions);

  // Register core routes
  registerRoutes(fastify, config);

  // httpExt: additional auth strategies
  if (config.httpExt?.authStrategies) {
    for (const strategy of config.httpExt.authStrategies) {
      registerExtAuthStrategy(fastify, strategy, config);
    }
  }

  // httpExt: additional plugins (as Fastify plugins)
  if (config.httpExt?.plugins) {
    for (const plugin of config.httpExt.plugins) {
      await fastify.register(plugin);
    }
  }

  // httpExt: additional routes
  if (config.httpExt?.routes) {
    for (const route of config.httpExt.routes) {
      registerExtRoute(fastify, route, config);
    }
  }

  // Start Fastify on internal port (used as debug port; main path uses inject())
  await fastify.listen({ port: config.http.port, host: config.http.host });
  debug('fastify server running on port:', config.http.port);

  const aedes = await launchAedes(config);

  // WebSocket server — noServer mode for direct upgrade handling
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket) => {
    aedes.handle(createWebSocketStream(socket));
  });

  return { fastify, aedes, wss };
}

function registerExtAuthStrategy(fastify, strategy, config) {
  const decoratorName = strategy.options?.requestDecoratorName || strategy.name;
  const cookieConfig = strategy.options?.cookie;

  if (!cookieConfig) {
    debugError('httpExt auth strategy missing cookie config:', strategy.name);
    return;
  }

  const cookieName = cookieConfig.name || strategy.name;

  // Decorate request with the named auth helper
  fastify.decorateRequest(decoratorName, null);
  fastify.addHook('onRequest', async (request, reply) => {
    // Read the strategy-specific cookie manually
    const cookieValue = request.cookies[cookieName];
    let sessionData = null;

    if (cookieValue) {
      try {
        // Try to decrypt using the strategy's secure session
        // For simplicity, store as signed cookie with JSON payload
        sessionData = JSON.parse(
          Buffer.from(cookieValue, 'base64').toString('utf8')
        );
      } catch {
        // Invalid cookie, ignore
      }
    }

    request[decoratorName] = {
      set: (val) => {
        const encoded = Buffer.from(JSON.stringify(val)).toString('base64');
        reply.setCookie(cookieName, encoded, {
          path: cookieConfig.path || `/${config.hsyncBase}`,
          secure: cookieConfig.isSecure || false,
          httpOnly: true,
          signed: true,
        });
        // Also update the in-flight request data
        request[decoratorName]._data = val;
      },
      clear: () => {
        reply.clearCookie(cookieName, {
          path: cookieConfig.path || `/${config.hsyncBase}`,
        });
        request[decoratorName]._data = null;
      },
      _data: sessionData,
    };

    // Set auth credentials from this strategy if available
    if (sessionData && !request.auth?.isAuthenticated) {
      request.auth = {
        credentials: sessionData,
        isAuthenticated: true,
      };
    }
  });
}

function registerExtRoute(fastify, route, config) {
  const routePath = `/${config.hsyncBase}/x${route.path}`.replace(/\{(\w+)\}/g, ':$1');
  const method = (route.method || 'GET').toLowerCase();

  const opts = {};

  // Convert Hapi validation to Fastify schema
  if (route.config?.validate?.payload) {
    opts.schema = opts.schema || {};
    opts.schema.body = route.config.validate.payload;
  }
  if (route.config?.validate?.query) {
    opts.schema = opts.schema || {};
    opts.schema.querystring = route.config.validate.query;
  }
  if (route.config?.validate?.params) {
    opts.schema = opts.schema || {};
    opts.schema.params = route.config.validate.params;
  }

  // Convert Hapi auth config to preHandler
  if (route.config?.auth) {
    const authConfig = route.config.auth;
    opts.preHandler = async (request, _reply) => {
      const mode = authConfig.mode || 'required';
      const isAuthed = request.auth?.isAuthenticated;

      if (mode === 'required' && !isAuthed) {
        throw fastify.httpErrors.unauthorized();
      }

      // Scope check
      if (authConfig.scope && isAuthed) {
        const userScope = request.auth.credentials?.scope || [];
        const hasScope = authConfig.scope.some((s) => userScope.includes(s));
        if (!hasScope) {
          throw fastify.httpErrors.forbidden('Insufficient scope');
        }
      }
    };
  }

  // Copy description/tags
  if (route.config?.description) {
    opts.schema = opts.schema || {};
    opts.schema.description = route.config.description;
  }
  if (route.config?.tags) {
    opts.schema = opts.schema || {};
    opts.schema.tags = route.config.tags;
  }

  // The handler — route.handler or route.config.handler
  const handler = route.handler || route.config?.handler;

  fastify[method](routePath, opts, handler);
  debug('registered httpExt route', method.toUpperCase(), routePath);
}

export default startFastify;

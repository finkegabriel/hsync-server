import net from 'net';
import http from 'http';
import b64id from 'b64id';
import createDebug from 'debug';
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { mplex } from '@libp2p/mplex'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'

import { createParser } from './lib/simple-parse.js';
import sockets from './lib/socket-map.js';
import { forwardWebRequest, sendCloseRequest } from './aedes.js';
import startFastify from './fastify.js';
import defaultConfig from './config.js';

const debug = createDebug('hsync:info');
const debugError = createDebug('error');

const server = await createLibp2p({
  addresses: {
    listen: ['/ip4/0.0.0.0/tcp/8884']
  },
  transports: [
    tcp()
  ],
  streamMuxers: [
    mplex()
  ],
  connectionEncryption: [
    noise()
  ],
  services: {
    relay: circuitRelayServer({
      reservations:{
        maxReservations: 100, // Number of client slots
        reservationTtl: 300000,
      }
    })
  }
});

async function run(conf = {}) {
  const config = { ...defaultConfig, ...conf };
  const HSYNC_CONNECT_PATH = `/${config.hsyncBase}`;

  const { fastify, wss } = await startFastify(config);

  if(config.enableP2P) {
    await server.start();
    console.log('Libp2p started with addresses:');
    server.getMultiaddrs().forEach((addr) => {
      console.log(addr.toString());
    });
    debug('libp2p started with id', server.peerId.toString());
  }

  // Handle HTTP requests to /_hs/* via fastify.inject() — no TCP loopback
  async function handleLocalHttpRequest(socket, data, parsed) {
    try {
      // Extract body from raw data (everything after \r\n\r\n)
      const headerEnd = data.indexOf('\r\n\r\n');
      const body = headerEnd >= 0 ? data.slice(headerEnd + 4) : undefined;

      const response = await fastify.inject({
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers,
        payload: body?.length ? body : undefined,
      });

      // Write raw HTTP response to external socket
      const statusMessage = response.statusMessage || 'OK';
      socket.write(`HTTP/1.1 ${response.statusCode} ${statusMessage}\r\n`);
      const headers = response.headers;
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            socket.write(`${key}: ${v}\r\n`);
          }
        } else {
          socket.write(`${key}: ${value}\r\n`);
        }
      }
      socket.write('\r\n');
      if (response.rawPayload?.length) {
        socket.write(response.rawPayload);
      }
      socket.end();
      delete sockets[socket.socketId];
    } catch (e) {
      debugError('inject error', socket.socketId, e);
      socket.end();
      delete sockets[socket.socketId];
    }
  }

  // Handle WebSocket upgrades directly — no TCP loopback
  function handleWebSocketUpgrade(socket, data, parsed) {
    // Synthesize http.IncomingMessage for ws.handleUpgrade
    const req = new http.IncomingMessage(socket);
    req.method = parsed.method;
    req.url = parsed.url;
    req.headers = parsed.headers;
    req.httpVersion = '1.1';
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;

    wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => {
      wss.emit('connection', ws, req);
    });
  }

  const socketServer = net.createServer((socket) => {
    socket.socketId = b64id.generateId();
    sockets[socket.socketId] = socket;
    socket.parsingStarted = false;
    socket.parsingFinished = false;
    socket.hsyncClient = false;

    socket.on('data', async (data) => {
      // After WebSocket upgrade, ws owns the socket — don't process its frames
      if (socket.hsyncClient) {
        return;
      }

      debug(
        `→ EXTERNAL DATA ${socket.socketId}`,
        socket.hostName,
        data.length,
        'parsingStarted',
        socket.parsingStarted,
        'finished',
        socket.parsingFinished
      );

      const headerParser = createParser(data);
      if (!socket.parsingStarted) {
        socket.parsingStarted = true;
        const startTime = Date.now();

        try {
          const parsed = await headerParser.parse();
          socket.parsingFinished = true;
          debug('path', parsed.url, Date.now() - startTime, socket.socketId);
          socket.hostName = parsed.host;
          socket.originalUrl = parsed.url;

          let toSend = data;
          if (socket.webQueue && socket.webQueue.length) {
            toSend = Buffer.concat([data, ...socket.webQueue]);
            debug(
              'adding web queue to data',
              socket.socketId,
              socket.webQueue.length,
              toSend.length
            );
            socket.webQueue = [];
          }

          if (parsed.url.startsWith(HSYNC_CONNECT_PATH) || parsed.url === '/favicon.ico') {
            debug('hsync path', parsed.url);

            // WebSocket upgrade — handle directly, no loopback
            if (parsed.headers.upgrade?.toLowerCase() === 'websocket') {
              socket.hsyncClient = true;
              handleWebSocketUpgrade(socket, toSend, parsed);
              return;
            }

            // HTTP request — use fastify.inject(), no loopback
            await handleLocalHttpRequest(socket, toSend, parsed);
            return;
          }

          debug('regular request', socket.originalUrl, socket.hostName, socket.socketId);
          forwardWebRequest(socket, toSend, parsed);
          return;
        } catch (e) {
          debugError('could not parse', socket.socketId, e);
          socket.end();
          delete sockets[socket.socketId];
        }
      } else if (socket.parsingStarted && !socket.parsingFinished) {
        debug('adding data to webqueue while parsing', socket.socketId, data.length);
        socket.webQueue = socket.webQueue || [];
        socket.webQueue.push(data);
        headerParser.addData(data);
      } else if (socket.parsingFinished) {
        debug('more data on same con', socket.originalUrl, socket.socketId);
        return forwardWebRequest(socket, data);
      }
    });

    socket.on('close', () => {
      if (socket.hostName && !socket.hsyncClient) {
        debug('SENDING CLOSE REQUEST', socket.socketId, socket.hostName);
        sendCloseRequest(socket.hostName, socket.socketId);
      }
      if (sockets[socket.socketId]) {
        delete sockets[socket.socketId];
      }
    });

    socket.on('error', (error) => {
      debugError('socket error', socket.socketId, error);
      if (sockets[socket.socketId]) {
        delete sockets[socket.socketId];
      }
    });
  });

  socketServer.listen(config.port);
  debug('hsync server listening on port', config.port);
}

export default run;

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Mock config
vi.mock('../../config.js', () => ({
  default: {
    hsyncSecret: 'test-secret',
    hsyncBase: '_hs',
    unauthedNames: false,
    unauthedTimeout: 3600000,
    unauthedNameChars: 8,
  },
  DEFAULTS: {
    RPC_TIMEOUT_MS: 5000,
    HTTP_WAIT_TIMEOUT_MS: 3000,
    DYN_CLEANUP_INTERVAL_MS: 60000,
  },
}));

import {
  launchAedes,
  forwardWebRequest,
  sendCloseRequest,
  rpcToClient,
  peerRpcToClient,
  peerNotifyToClient,
} from '../../aedes.js';
import sockets from '../../lib/socket-map.js';

function createMockSocket(id, hostName) {
  const writes = [];
  return {
    socketId: id || 'test-socket-1',
    hostName: hostName || 'testhost.example.com',
    originalUrl: '/test',
    write: vi.fn((data) => writes.push(data)),
    end: vi.fn(),
    destroy: vi.fn(),
    _writes: writes,
  };
}

function callbackToPromise(fn) {
  return new Promise((resolve, reject) => {
    fn((err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

describe('aedes integration', () => {
  let aedesInstance;

  beforeAll(() => {
    aedesInstance = launchAedes({
      hsyncSecret: 'test-secret',
      unauthedNames: false,
      auth: null,
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => aedesInstance.close(resolve));
  });

  beforeEach(() => {
    for (const key in sockets) {
      delete sockets[key];
    }
  });

  describe('launchAedes', () => {
    it('should return an aedes instance', () => {
      expect(aedesInstance).toBeDefined();
      expect(typeof aedesInstance.publish).toBe('function');
      expect(typeof aedesInstance.handle).toBe('function');
    });

    it('should have authenticate callback', () => {
      expect(aedesInstance.authenticate).toBeDefined();
    });

    it('should have authorizePublish callback', () => {
      expect(aedesInstance.authorizePublish).toBeDefined();
    });

    it('should have authorizeSubscribe callback', () => {
      expect(aedesInstance.authorizeSubscribe).toBeDefined();
    });
  });

  describe('forwardWebRequest', () => {
    it('should end socket if hostName is missing', () => {
      const socket = createMockSocket('s1');
      socket.hostName = null;

      forwardWebRequest(socket, Buffer.from('GET / HTTP/1.1\r\n'), { headers: {} });

      expect(socket.end).toHaveBeenCalled();
    });

    it('should return bad gateway when no MQTT clients connected', () => {
      const socket = createMockSocket('s1', 'myhost.example.com');
      sockets[socket.socketId] = socket;

      forwardWebRequest(socket, Buffer.from('GET / HTTP/1.1\r\n'), { headers: {} });

      expect(socket.write).toHaveBeenCalled();
      const written = socket._writes.join('');
      expect(written).toContain('502');
      expect(socket.end).toHaveBeenCalled();
      expect(sockets[socket.socketId]).toBeUndefined();
    });

    it('should publish to MQTT when clients are connected', () => {
      aedesInstance.clients['mock-client'] = { id: 'mock-client' };

      const socket = createMockSocket('s2', 'test.example.com');
      sockets[socket.socketId] = socket;

      forwardWebRequest(
        socket,
        Buffer.from('GET /test HTTP/1.1\r\nHost: test.example.com\r\n\r\n'),
        { headers: { connection: 'keep-alive' } }
      );

      expect(socket.end).not.toHaveBeenCalled();
      delete aedesInstance.clients['mock-client'];
    });

    it('should handle continuation data without info param', () => {
      aedesInstance.clients['mock-client-2'] = { id: 'mock-client-2' };

      const socket = createMockSocket('s3', 'test2.example.com');
      sockets[socket.socketId] = socket;

      forwardWebRequest(socket, Buffer.from('more body data'));

      expect(socket.end).not.toHaveBeenCalled();
      delete aedesInstance.clients['mock-client-2'];
    });
  });

  describe('authorizePublish - reply topic', () => {
    it('should write payload to socket on reply', async () => {
      const socket = createMockSocket('reply-sock');
      sockets['reply-sock'] = socket;
      const payload = Buffer.from('HTTP/1.1 200 OK\r\n\r\nHello');

      await callbackToPromise((cb) =>
        aedesInstance.authorizePublish(
          { hostName: 'somehost' },
          { topic: 'reply/somehost/reply-sock', payload },
          cb
        )
      );

      expect(socket.write).toHaveBeenCalledWith(payload);
    });

    it('should not crash if socket not found', async () => {
      await callbackToPromise((cb) =>
        aedesInstance.authorizePublish(
          { hostName: 'somehost' },
          { topic: 'reply/somehost/nonexistent', payload: Buffer.from('data') },
          cb
        )
      );
    });
  });

  describe('authorizePublish - close topic', () => {
    it('should end socket and clean up', async () => {
      const socket = createMockSocket('close-sock');
      sockets['close-sock'] = socket;

      await callbackToPromise((cb) =>
        aedesInstance.authorizePublish(
          { hostName: 'somehost' },
          { topic: 'close/somehost/close-sock', payload: Buffer.from('') },
          cb
        )
      );

      expect(socket.end).toHaveBeenCalled();
      expect(sockets['close-sock']).toBeUndefined();
    });
  });

  describe('authorizePublish - msg topic', () => {
    it('should reject messaging self', async () => {
      await expect(
        callbackToPromise((cb) =>
          aedesInstance.authorizePublish(
            { hostName: 'myhost' },
            { topic: 'msg/myhost/myhost', payload: Buffer.from('hi') },
            cb
          )
        )
      ).rejects.toThrow('cant send message to self');
    });

    it('should reject spoofed sender', async () => {
      await expect(
        callbackToPromise((cb) =>
          aedesInstance.authorizePublish(
            { hostName: 'realhost' },
            { topic: 'msg/otherhost/fakehost', payload: Buffer.from('hi') },
            cb
          )
        )
      ).rejects.toThrow('must specify own name');
    });

    it('should allow valid msg publish', async () => {
      await callbackToPromise((cb) =>
        aedesInstance.authorizePublish(
          { hostName: 'myhost' },
          { topic: 'msg/otherhost/myhost', payload: Buffer.from('hi') },
          cb
        )
      );
    });
  });

  describe('authorizePublish - srpc topic', () => {
    it('should reject srpc from wrong client', async () => {
      await expect(
        callbackToPromise((cb) =>
          aedesInstance.authorizePublish(
            { hostName: 'myhost' },
            { topic: 'srpc/otherhost', payload: Buffer.from('{}') },
            cb
          )
        )
      ).rejects.toThrow('cant rpc to server for someone else');
    });
  });

  describe('authorizePublish - rpc topic', () => {
    it('should reject rpc from wrong client', async () => {
      await expect(
        callbackToPromise((cb) =>
          aedesInstance.authorizePublish(
            { hostName: 'myhost' },
            { topic: 'rpc/otherhost/req123', payload: Buffer.from('{}') },
            cb
          )
        )
      ).rejects.toThrow('cant rpc to server for someone else');
    });
  });

  describe('authorizeSubscribe', () => {
    it('should allow any subscription', async () => {
      const sub = { topic: 'web/test/#', qos: 0 };
      const result = await callbackToPromise((cb) =>
        aedesInstance.authorizeSubscribe({ id: 'test-client' }, sub, cb)
      );
      expect(result).toBe(sub);
    });
  });

  describe('rpcToClient', () => {
    it('should throw 404 for unknown hostname', async () => {
      try {
        await rpcToClient('nonexistent.host', 'ping');
        expect.unreachable();
      } catch (e) {
        expect(e.statusCode).toBe(404);
        expect(e.message).toContain('Client not found');
      }
    });
  });

  describe('peerRpcToClient', () => {
    it('should throw 404 for unknown target', async () => {
      try {
        await peerRpcToClient({
          toHost: 'http://nonexistent.example.com',
          fromHost: 'http://sender.example.com',
          msg: { method: 'test', params: [] },
        });
        expect.unreachable();
      } catch (e) {
        expect(e.statusCode).toBe(404);
      }
    });
  });

  describe('peerNotifyToClient', () => {
    it('should throw 404 for unknown target', async () => {
      try {
        await peerNotifyToClient('nonexistent.host', 'test', {});
        expect.unreachable();
      } catch (e) {
        expect(e.statusCode).toBe(404);
      }
    });
  });

  describe('sendCloseRequest', () => {
    it('should publish to close topic without throwing', () => {
      expect(() => {
        sendCloseRequest('somehost.example.com', 'socket-123');
      }).not.toThrow();
    });
  });
});

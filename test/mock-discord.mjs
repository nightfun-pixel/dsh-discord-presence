/**
 * A stand-in Discord desktop client for tests.
 *
 * It listens on a real socket path — a named pipe on Windows, a unix socket
 * elsewhere — speaks the same framed protocol, and records every frame it
 * receives. That covers everything about the transport except "does Discord accept
 * this activity", which only a real application id can answer.
 *
 * @module discord-presence/test/mock-discord
 */

import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DiscordIpc, OP, decodeFrames, encodeFrame } from '../lib/discord-ipc.js';

/** A unique socket path per server, so parallel test files cannot collide. */
let socketSeq = 0;
export function uniqueSocketPath() {
  socketSeq += 1;
  const name = `dsh-discord-presence-test-${process.pid}-${socketSeq}`;
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  return path.join(os.tmpdir(), `${name}.sock`);
}

/** Wait for one event, failing the test instead of hanging forever. */
export function once(emitter, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    emitter.once(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/** Wait until `check()` is true, polling briefly. */
export async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A mock Discord client.
 *
 * `behavior` decides how it answers the handshake: `ready` (normal), `close`
 * (a fatal CLOSE frame with a chosen code), or `silent`.
 */
export class MockDiscord {
  /** @param {{ behavior?: 'ready' | 'close' | 'silent', closeCode?: number, closeMessage?: string }} [options] */
  constructor(options = {}) {
    this.behavior = options.behavior ?? 'ready';
    this.closeCode = options.closeCode ?? 4000;
    this.closeMessage = options.closeMessage ?? 'Invalid Client ID';
    this.path = uniqueSocketPath();
    /** Every frame the client sent, in order. */
    this.received = [];
    /** Every frame the server sent, in order. */
    this.sent = [];
    this.sockets = [];
    this.buffer = Buffer.alloc(0);
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  onConnection(socket) {
    this.sockets.push(socket);
    this.buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const { frames, rest } = decodeFrames(this.buffer);
      this.buffer = rest;
      for (const frame of frames) this.onFrame(socket, frame);
    });
    socket.on('error', () => {});
  }

  onFrame(socket, frame) {
    this.received.push(frame);
    if (frame.op === OP.HANDSHAKE) {
      if (this.behavior === 'silent') return;
      if (this.behavior === 'close') {
        this.send(socket, OP.CLOSE, { code: this.closeCode, message: this.closeMessage });
        return;
      }
      this.send(socket, OP.FRAME, {
        cmd: 'DISPATCH',
        evt: 'READY',
        data: { v: 1, config: {}, user: { id: '1', username: 'mock' } },
        nonce: null,
      });
      return;
    }
    if (frame.op === OP.PING) {
      this.send(socket, OP.PONG, frame.payload);
      return;
    }
    if (frame.op === OP.FRAME) {
      // Discord answers a command with a frame carrying the same nonce.
      this.send(socket, OP.FRAME, { cmd: frame.payload.cmd, evt: null, data: {}, nonce: frame.payload.nonce });
    }
  }

  send(socket, op, payload) {
    this.sent.push({ op, payload });
    socket.write(encodeFrame(op, payload));
  }

  /** Send raw bytes, for the partial-frame test. */
  sendRaw(socket, bytes) {
    socket.write(bytes);
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.path, () => resolve(this));
    });
  }

  close() {
    return new Promise((resolve) => {
      for (const socket of this.sockets) socket.destroy();
      this.server.close(() => {
        if (process.platform !== 'win32') fs.rmSync(this.path, { force: true });
        resolve();
      });
    });
  }

  /** Frames of one command, in order. */
  commands(cmd) {
    return this.received.filter((frame) => frame.op === OP.FRAME && frame.payload?.cmd === cmd).map((frame) => frame.payload);
  }

  /** The activities of every SET_ACTIVITY frame, in order. */
  activities() {
    return this.commands('SET_ACTIVITY').map((command) => command.args.activity);
  }

  /** Drop every live client connection, simulating a Discord restart. */
  dropConnections() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets = [];
  }
}

/** A transport wired to one mock server, with a fast throttle so tests stay quick. */
export function makeClient(mock, overrides = {}) {
  return new DiscordIpc({
    clientId: '123456789012345678',
    candidates: [mock.path],
    minUpdateIntervalMs: 30,
    pingIntervalMs: 0,
    ...overrides,
  });
}

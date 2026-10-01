/**
 * Manual probe: talk to the Discord desktop client's local IPC socket directly.
 *
 * Answers two questions that no offline test can:
 *   1. Is a Discord client running, and on which socket index?
 *   2. Does our framing survive contact with the real server, and what does the
 *      server say about the client id we hand it?
 *
 * Usage:
 *   node plugins/discord-presence/test/probe-live-discord.mjs [clientId]
 *
 * Without a client id it sends a deliberately unknown one. Discord answers
 * `CLOSE {code: 4000, message: "Invalid Client ID"}`, which still proves the
 * frame layout, the handshake shape and the socket path are right — that is the
 * point of the probe.
 */

import net from 'node:net';

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

/** Same candidate list the transport walks, minus the reconnect logic. */
function socketCandidates() {
  if (process.platform === 'win32') {
    return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  }
  const base = process.env.XDG_RUNTIME_DIR ?? process.env.TMPDIR ?? process.env.TMP ?? '/tmp';
  const roots = [base, `${base}/app/com.discordapp.Discord`, `${base}/snap.discord`, `${base}/.flatpak/dev.vencord.Vesktop`];
  return roots.flatMap((root) => Array.from({ length: 10 }, (_, i) => `${root.replace(/\/+$/u, '')}/discord-ipc-${i}`));
}

/** Encode one IPC frame: uint32LE opcode, uint32LE length, UTF-8 JSON body. */
function encode(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(8 + body.length);
  frame.writeUInt32LE(op, 0);
  frame.writeUInt32LE(body.length, 4);
  body.copy(frame, 8);
  return frame;
}

const clientId = process.argv[2] ?? '000000000000000000';
const candidates = socketCandidates();
let index = 0;

function tryNext() {
  if (index >= candidates.length) {
    console.log('RESULT: no Discord IPC socket found. Is the Discord desktop app running?');
    process.exit(1);
  }
  const path = candidates[index++];
  const socket = net.connect(path);
  socket.once('error', (error) => {
    console.log(`  ${path} -> ${error.code}`);
    tryNext();
  });
  socket.once('connect', () => {
    console.log(`CONNECTED: ${path}`);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const op = buffer.readUInt32LE(0);
        const length = buffer.readUInt32LE(4);
        if (buffer.length < 8 + length) break;
        const body = buffer.subarray(8, 8 + length).toString('utf8');
        buffer = buffer.subarray(8 + length);
        const name = Object.keys(OP).find((key) => OP[key] === op) ?? `op${op}`;
        console.log(`RECV ${name}: ${body}`);
        if (op === OP.CLOSE) {
          console.log(`RESULT: server closed the session (see code above) — framing is correct.`);
          socket.end();
          process.exit(0);
        }
        if (op === OP.FRAME && body.includes('"READY"')) {
          console.log('RESULT: handshake accepted; this client id is registered.');
          socket.write(encode(OP.PING, { probe: true }));
          setTimeout(() => {
            socket.end();
            process.exit(0);
          }, 500);
        }
        if (op === OP.PONG) {
          console.log('RESULT: ping/pong round-trip works.');
          socket.end();
          process.exit(0);
        }
      }
    });
    console.log(`SEND HANDSHAKE: {"v":1,"client_id":"${clientId}"}`);
    socket.write(encode(OP.HANDSHAKE, { v: 1, client_id: clientId }));
    setTimeout(() => {
      console.log('RESULT: no reply within 3s.');
      socket.destroy();
      process.exit(1);
    }, 3000);
  });
}

tryNext();

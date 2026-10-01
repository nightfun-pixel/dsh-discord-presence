/**
 * Minimal, dependency-free Discord local-RPC (IPC) client.
 *
 * Discord's desktop client exposes a local socket — a named pipe on Windows, a
 * unix socket elsewhere — and speaks a tiny framed JSON protocol over it. This
 * module implements just enough of it to drive Rich Presence:
 *
 *   frame = uint32LE opcode | uint32LE bodyLength | UTF-8 JSON body
 *
 *   op 0 HANDSHAKE  { v: 1, client_id }            -> DISPATCH READY, or CLOSE
 *   op 1 FRAME      { cmd, args, nonce }           -> reply carrying the nonce
 *   op 2 CLOSE      { code, message }              <- fatal; do not retry blindly
 *   op 3 PING       anything                       -> op 4 PONG (echo)
 *
 * Nothing here imports a third-party package on purpose: a profile-installed
 * bundle resolves bare specifiers from its own directory, which cannot see the
 * dsh installation's `node_modules`.
 *
 * The class never throws at its caller. Every failure becomes a state change
 * reported through `onState`, because a missing Discord client must not take the
 * harness down with it.
 *
 * @module discord-presence/lib/discord-ipc
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';

/** Wire opcodes. */
export const OP = Object.freeze({ HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 });

/** Discord's documented reason for refusing an unregistered application id. */
const INVALID_CLIENT_ID = 4000;

/** How long a handshake may stay unanswered before we call the socket dead. */
const HANDSHAKE_TIMEOUT_MS = 10000;

/** Socket indexes Discord walks; a second client takes the next free index. */
const SOCKET_COUNT = 10;

/**
 * Every socket path worth trying, in order.
 *
 * Windows is the simple case. Elsewhere Discord may live in the user's runtime
 * directory directly, or under the snap / flatpak sandbox prefixes, so all of
 * them are candidates rather than a single guess.
 *
 * @returns {string[]} absolute socket paths, most likely first.
 */
export function socketCandidates() {
  if (process.platform === 'win32') {
    // `\\?\pipe\...` and `\\.\pipe\...` are the same namespace to Node; Discord's
    // own libraries use the `\\?\` form, so it goes first.
    return Array.from({ length: SOCKET_COUNT }, (_, index) => `\\\\?\\pipe\\discord-ipc-${index}`);
  }
  const runtime = process.env.XDG_RUNTIME_DIR ?? process.env.TMPDIR ?? process.env.TMP ?? '/tmp';
  const roots = [
    runtime,
    `${runtime}/app/com.discordapp.Discord`,
    `${runtime}/snap.discord`,
    `${runtime}/.flatpak/dev.vencord.Vesktop`,
    `${runtime}/.flatpak/com.discordapp.Discord`,
  ];
  return roots.flatMap((root) =>
    Array.from({ length: SOCKET_COUNT }, (_, index) => `${root.replace(/\/+$/u, '')}/discord-ipc-${index}`),
  );
}

/**
 * Encode one IPC frame.
 * @param {number} op - one of {@link OP}.
 * @param {unknown} payload - JSON-serializable body.
 * @returns {Buffer} the framed bytes.
 */
export function encodeFrame(op, payload) {
  const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  const frame = Buffer.allocUnsafe(8 + body.length);
  frame.writeUInt32LE(op, 0);
  frame.writeUInt32LE(body.length, 4);
  body.copy(frame, 8);
  return frame;
}

/**
 * Split a byte stream into frames.
 *
 * A socket read is not a message boundary, so frames are buffered until the
 * declared length has arrived. A malformed length is fatal for the stream: the
 * only way to resynchronize is a fresh connection.
 *
 * @param {Buffer} buffer - bytes received so far.
 * @returns {{ frames: Array<{ op: number, payload: any }>, rest: Buffer }} decoded frames and the remainder.
 */
export function decodeFrames(buffer) {
  const frames = [];
  let rest = buffer;
  while (rest.length >= 8) {
    const op = rest.readUInt32LE(0);
    const length = rest.readUInt32LE(4);
    if (rest.length < 8 + length) break;
    const text = rest.subarray(8, 8 + length).toString('utf8');
    rest = rest.subarray(8 + length);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
    frames.push({ op, payload });
  }
  return { frames, rest };
}

/**
 * A reconnecting Discord IPC session.
 *
 * Lifecycle: `start()` walks {@link socketCandidates} until one connects, then
 * handshakes. On READY the session is usable and the last requested activity is
 * (re)sent. Any drop schedules a reconnect with exponential backoff, except a
 * CLOSE 4000, which means the configured application id does not exist — that is
 * a configuration error, and retrying it forever would only hide the message.
 *
 * Events: `state` (`{ state, detail }`), `ready`, `activity` (`{ ok, error }`),
 * `log` (`{ level, message }`).
 */
export class DiscordIpc extends EventEmitter {
  /**
   * @param {object} options - session options.
   * @param {string} options.clientId - Discord application id; required by the handshake.
   * @param {number} [options.minUpdateIntervalMs] - floor between two SET_ACTIVITY calls (Discord rate-limits these).
   * @param {number} [options.pingIntervalMs] - keepalive period; 0 disables it.
   * @param {(message: string) => void} [options.log] - sink for diagnostics.
   * @param {string[]} [options.candidates] - override the socket paths (tests point this at a mock server).
   */
  constructor(options) {
    super();
    this.clientId = options.clientId;
    this.minUpdateIntervalMs = options.minUpdateIntervalMs ?? 15000;
    this.pingIntervalMs = options.pingIntervalMs ?? 30000;
    this.candidates = options.candidates ?? socketCandidates();
    this.log = options.log ?? (() => {});

    /** @type {net.Socket | undefined} */
    this.socket = undefined;
    /** Current connection state, also mirrored into the status file. */
    this.state = 'idle';
    /** Human-readable companion to {@link DiscordIpc#state}. */
    this.detail = 'not started';
    /** Last activity requested by the caller; replayed after every reconnect. */
    this.desiredActivity = undefined;
    /** Activity currently known to be set on the Discord side. */
    this.appliedActivity = undefined;
    /** True once a HANDSHAKE has been answered with DISPATCH READY. */
    this.ready = false;

    this.attempt = 0;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nonceSeq = 0;
    this.lastSentAt = 0;
    this.flushTimer = undefined;
    this.reconnectTimer = undefined;
    this.pingTimer = undefined;
    this.handshakeTimer = undefined;
  }

  /** Record a state change and tell anyone listening. */
  setState(state, detail) {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.emit('state', { state, detail });
  }

  /** Start connecting. Safe to call once; later calls are ignored. */
  start() {
    if (this.closed) return;
    if (this.socket !== undefined || this.reconnectTimer !== undefined) return;
    if (typeof this.clientId !== 'string' || this.clientId.trim().length === 0) {
      this.setState('unconfigured', 'no Discord application id configured');
      return;
    }
    this.connectToAny();
  }

  /**
   * Walk the candidate sockets until one accepts a connection.
   * A candidate that errors is simply the next one's turn.
   * @param {number} [from] - index into {@link DiscordIpc#candidates}.
   */
  connectToAny(from = 0) {
    if (this.closed) return;
    if (from >= this.candidates.length) {
      this.setState('offline', 'no Discord IPC socket answered (is the Discord desktop app running?)');
      this.scheduleReconnect();
      return;
    }
    const path = this.candidates[from];
    this.setState('connecting', `trying ${path}`);
    const socket = net.connect(path);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      this.attach(socket, path);
    });
    socket.once('error', () => {
      socket.destroy();
      this.connectToAny(from + 1);
    });
  }

  /**
   * Adopt a connected socket and handshake on it.
   * @param {net.Socket} socket - the connected socket.
   * @param {string} path - the path it came from, for diagnostics.
   */
  attach(socket, path) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.ready = false;
    this.socketPath = path;
    this.setState('handshaking', `connected to ${path}`);

    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.onDrop(`socket error: ${error.message}`));
    socket.on('close', () => this.onDrop('socket closed'));

    this.handshakeTimer = setTimeout(() => {
      this.onDrop(`no handshake reply within ${HANDSHAKE_TIMEOUT_MS} ms`);
    }, HANDSHAKE_TIMEOUT_MS);
    this.handshakeTimer.unref?.();

    this.write(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
  }

  /**
   * Handle one inbound chunk: decode every complete frame in it.
   * @param {Buffer} chunk - bytes from the socket.
   */
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { frames, rest } = decodeFrames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) this.onFrame(frame.op, frame.payload);
  }

  /**
   * React to one decoded frame.
   * @param {number} op - wire opcode.
   * @param {any} payload - decoded body.
   */
  onFrame(op, payload) {
    if (op === OP.PING) {
      this.write(OP.PONG, payload);
      return;
    }
    if (op === OP.PONG) return;
    if (op === OP.CLOSE) {
      const code = payload?.code;
      const message = payload?.message ?? 'closed by Discord';
      if (code === INVALID_CLIENT_ID) {
        // Terminal configuration error: the application id does not exist, so no
        // amount of reconnecting will help. Stop and say so.
        this.closed = true;
        this.ready = false;
        this.setState('invalid-client-id', `${message} (code ${code})`);
        this.teardown();
        return;
      }
      this.onDrop(`Discord closed the session: ${message} (code ${code})`);
      return;
    }
    if (op !== OP.FRAME) return;

    if (payload?.evt === 'READY') {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
      this.ready = true;
      this.attempt = 0;
      this.setState('connected', `ready on ${this.socketPath}`);
      this.emit('ready', payload.data);
      this.startPing();
      // A reconnect must not lose the activity the caller last asked for.
      if (this.desiredActivity !== undefined) {
        this.appliedActivity = undefined;
        this.flush(true);
      }
      return;
    }

    const nonce = payload?.nonce;
    if (typeof nonce === 'string' && this.pending.has(nonce)) {
      const settle = this.pending.get(nonce);
      this.pending.delete(nonce);
      settle(payload);
    }
  }

  /**
   * Send one frame, ignoring a socket that is not there.
   * @param {number} op - wire opcode.
   * @param {unknown} payload - body.
   * @returns {boolean} whether the bytes reached a live socket.
   */
  write(op, payload) {
    const socket = this.socket;
    if (socket === undefined || socket.destroyed === true) return false;
    try {
      socket.write(encodeFrame(op, payload));
      return true;
    } catch (error) {
      this.onDrop(`write failed: ${error.message}`);
      return false;
    }
  }

  /** Keep the session warm; Discord drops idle sockets. */
  startPing() {
    if (this.pingIntervalMs <= 0) return;
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.write(OP.PING, { t: Date.now() }), this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  /**
   * Request an activity, coalescing bursts.
   *
   * Discord allows a handful of presence updates per 20 seconds, so a caller may
   * call this on every token count change without hammering the socket: the last
   * request inside the window wins.
   *
   * @param {object} activity - Discord activity payload.
   * @param {boolean} [immediate] - bypass the throttle (used right after READY).
   */
  setActivity(activity, immediate = false) {
    this.desiredActivity = activity;
    if (!this.ready) {
      // Remembered, not sent: the replay happens when the handshake lands.
      this.flush(true);
      return;
    }
    this.flush(immediate);
  }

  /** Clear the presence card entirely. */
  clearActivity() {
    this.desiredActivity = undefined;
    this.appliedActivity = undefined;
    if (!this.ready) return;
    this.request('SET_ACTIVITY', { pid: process.pid, activity: null });
  }

  /**
   * Send the desired activity if the throttle allows it.
   * @param {boolean} immediate - ignore the throttle.
   */
  flush(immediate) {
    if (!this.ready || this.desiredActivity === undefined) return;
    const serialized = JSON.stringify(this.desiredActivity);
    if (serialized === this.appliedActivity) return;
    const elapsed = Date.now() - this.lastSentAt;
    const wait = immediate ? 0 : Math.max(0, this.minUpdateIntervalMs - elapsed);
    if (wait > 0) {
      if (this.flushTimer === undefined) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = undefined;
          this.flush(false);
        }, wait);
        this.flushTimer.unref?.();
      }
      return;
    }
    this.lastSentAt = Date.now();
    this.appliedActivity = serialized;
    this.request('SET_ACTIVITY', { pid: process.pid, activity: this.desiredActivity });
  }

  /**
   * Send one command and resolve with the reply that carries its nonce.
   * @param {string} cmd - Discord RPC command name.
   * @param {object} args - command arguments.
   * @returns {Promise<any>} the reply frame, or `undefined` if the session dropped first.
   */
  request(cmd, args) {
    const nonce = `${Date.now().toString(36)}-${(this.nonceSeq += 1).toString(36)}`;
    const sent = this.write(OP.FRAME, { cmd, args, nonce });
    if (!sent) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        this.emit('activity', { ok: false, error: `no reply to ${cmd} within 10 s` });
        resolve(undefined);
      }, 10000);
      timer.unref?.();
      this.pending.set(nonce, (payload) => {
        clearTimeout(timer);
        const error = payload?.data?.message ?? (payload?.evt === 'ERROR' ? payload?.data?.message : undefined);
        if (typeof error === 'string' && error.length > 0) this.emit('activity', { ok: false, error });
        else this.emit('activity', { ok: true });
        resolve(payload);
      });
    });
  }

  /**
   * Handle a lost socket: report, tear down, and plan the next attempt.
   * @param {string} reason - what happened.
   */
  onDrop(reason) {
    if (this.socket === undefined) return;
    this.teardown();
    if (this.closed) return;
    this.setState('offline', reason);
    this.scheduleReconnect();
  }

  /** Drop socket-bound state without touching {@link DiscordIpc#desiredActivity}. */
  teardown() {
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.flushTimer);
    clearInterval(this.pingTimer);
    this.handshakeTimer = undefined;
    this.flushTimer = undefined;
    this.pingTimer = undefined;
    this.ready = false;
    this.buffer = Buffer.alloc(0);
    for (const settle of this.pending.values()) settle(undefined);
    this.pending.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      socket.removeAllListeners();
      socket.destroy();
    }
  }

  /** Exponential backoff, capped, so a closed Discord costs nothing measurable. */
  scheduleReconnect() {
    if (this.closed || this.reconnectTimer !== undefined) return;
    this.attempt += 1;
    const delay = Math.min(5000 * 2 ** (this.attempt - 1), 60000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectToAny();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Stop for good: clear the presence and close the socket. */
  stop() {
    this.closed = true;
    this.clearActivity();
    this.teardown();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.setState('stopped', 'stopped');
    this.removeAllListeners();
  }

  /** A snapshot for the status file and for settings diagnostics. */
  describe() {
    return {
      state: this.state,
      detail: this.detail,
      ready: this.ready,
      socket: this.socketPath,
      hasActivity: this.desiredActivity !== undefined,
      applied: this.appliedActivity !== undefined,
    };
  }
}

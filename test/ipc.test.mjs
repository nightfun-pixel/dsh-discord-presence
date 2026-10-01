/**
 * Offline tests for the Discord IPC transport.
 *
 * Run: node plugins/discord-presence/test/ipc.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordIpc, OP, decodeFrames, encodeFrame, socketCandidates } from '../lib/discord-ipc.js';
import { MockDiscord, makeClient, once, until } from './mock-discord.mjs';

test('encodeFrame/decodeFrames round-trip, including split frames', () => {
  const a = encodeFrame(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: 7 }, nonce: 'n1' });
  const b = encodeFrame(OP.PING, { t: 1 });
  const joined = Buffer.concat([a, b]);

  const whole = decodeFrames(joined);
  assert.equal(whole.frames.length, 2);
  assert.equal(whole.frames[0].op, OP.FRAME);
  assert.equal(whole.frames[0].payload.cmd, 'SET_ACTIVITY');
  assert.equal(whole.frames[1].op, OP.PING);
  assert.equal(whole.rest.length, 0);

  // A read that ends mid-header, then mid-body, must not lose the frame.
  const first = decodeFrames(joined.subarray(0, 3));
  assert.equal(first.frames.length, 0);
  assert.equal(first.rest.length, 3);
  const second = decodeFrames(joined.subarray(3, 10));
  assert.equal(second.frames.length, 0);
  const third = decodeFrames(Buffer.concat([first.rest, joined.subarray(3)]));
  assert.equal(third.frames.length, 2);
});

test('socketCandidates covers the documented Discord socket locations', () => {
  const candidates = socketCandidates();
  assert.equal(candidates.length >= 10, true);
  if (process.platform === 'win32') {
    assert.equal(candidates[0], '\\\\?\\pipe\\discord-ipc-0');
    assert.equal(candidates[9], '\\\\?\\pipe\\discord-ipc-9');
  } else {
    assert.equal(candidates.some((candidate) => candidate.endsWith('/discord-ipc-0')), true);
  }
});

test('handshake reaches READY and the activity is sent with the right shape', async () => {
  const mock = await new MockDiscord().listen();
  const client = makeClient(mock);
  try {
    client.start();
    await once(client, 'ready');

    assert.equal(mock.received[0].op, OP.HANDSHAKE);
    assert.deepEqual(mock.received[0].payload, { v: 1, client_id: '123456789012345678' });

    const activity = { details: 'default-workspace', state: 'flash · 12.4k tok', timestamps: { start: 1700000000000 } };
    client.setActivity(activity);
    await until(() => mock.commands('SET_ACTIVITY').length === 1);

    const sent = mock.commands('SET_ACTIVITY')[0];
    assert.equal(sent.args.pid, process.pid);
    assert.deepEqual(sent.args.activity, activity);
    assert.equal(client.describe().state, 'connected');
  } finally {
    client.stop();
    await mock.close();
  }
});

test('an unchanged activity is not resent, and bursts are coalesced', async () => {
  const mock = await new MockDiscord().listen();
  const client = makeClient(mock);
  try {
    client.start();
    await once(client, 'ready');

    client.setActivity({ details: 'a' });
    client.setActivity({ details: 'a' });
    client.setActivity({ details: 'a' });
    await until(() => mock.commands('SET_ACTIVITY').length === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(mock.commands('SET_ACTIVITY').length, 1, 'identical activity must be deduplicated');

    // Three different activities in one burst: the first goes out at once (the window
    // had already elapsed) and the rest collapse into the last one, skipping 'c'.
    client.setActivity({ details: 'b' });
    client.setActivity({ details: 'c' });
    client.setActivity({ details: 'd' });
    await until(() => mock.activities().some((activity) => activity.details === 'd'));
    const details = mock.activities().map((activity) => activity.details);
    assert.equal(details[0], 'a');
    assert.equal(details.includes('c'), false, 'a superseded activity must never reach the socket');
    assert.equal(details.at(-1), 'd');
    assert.equal(details.length <= 3, true);
  } finally {
    client.stop();
    await mock.close();
  }
});

test('a reconnect replays the activity the caller last asked for', async () => {
  const mock = await new MockDiscord().listen();
  const client = makeClient(mock, { minUpdateIntervalMs: 0 });
  try {
    client.start();
    await once(client, 'ready');
    client.setActivity({ details: 'survives-a-restart' });
    await until(() => mock.commands('SET_ACTIVITY').length === 1);

    mock.dropConnections();
    await until(() => client.describe().state === 'offline');
    // The first reconnect waits out a 5 s backoff; the test waits with it.
    await until(() => mock.commands('SET_ACTIVITY').length === 2, 8000);
    assert.equal(mock.activities()[1].details, 'survives-a-restart');
    assert.equal(mock.received.filter((frame) => frame.op === OP.HANDSHAKE).length >= 2, true);
  } finally {
    client.stop();
    await mock.close();
  }
});

test('CLOSE 4000 is terminal: no reconnect, and the reason is visible', async () => {
  const mock = await new MockDiscord({ behavior: 'close', closeCode: 4000 }).listen();
  const client = makeClient(mock);
  const states = [];
  client.on('state', (change) => states.push(change));
  try {
    client.start();
    await until(() => client.describe().state === 'invalid-client-id');
    assert.match(client.describe().detail, /Invalid Client ID/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(client.describe().state, 'invalid-client-id', 'must not retry a configuration error');
    assert.equal(states.some((change) => change.state === 'connected'), false);
  } finally {
    client.stop();
    await mock.close();
  }
});

test('a non-fatal CLOSE reconnects instead of giving up', async () => {
  const mock = await new MockDiscord({ behavior: 'close', closeCode: 4004 }).listen();
  const client = makeClient(mock);
  try {
    client.start();
    await until(() => client.describe().state === 'offline');
    assert.match(client.describe().detail, /code 4004/);
  } finally {
    client.stop();
    await mock.close();
  }
});

test('a silent server is reported as handshaking, not as a hang', async () => {
  const mock = await new MockDiscord({ behavior: 'silent' }).listen();
  const client = makeClient(mock);
  try {
    client.start();
    await until(() => client.describe().state === 'handshaking');
    assert.equal(client.describe().ready, false);
  } finally {
    client.stop();
    await mock.close();
  }
});

test('PING from Discord is answered with PONG echoing the payload', async () => {
  const mock = await new MockDiscord().listen();
  const client = makeClient(mock);
  try {
    client.start();
    await once(client, 'ready');
    mock.send(mock.sockets[0], OP.PING, { hello: 'there' });
    await until(() => mock.received.some((frame) => frame.op === OP.PONG));
    const pong = mock.received.find((frame) => frame.op === OP.PONG);
    assert.deepEqual(pong.payload, { hello: 'there' });
  } finally {
    client.stop();
    await mock.close();
  }
});

test('a frame split across reads is reassembled', async () => {
  const mock = await new MockDiscord().listen();
  const client = makeClient(mock);
  try {
    client.start();
    await once(client, 'ready');
    const bytes = encodeFrame(OP.FRAME, { cmd: 'PING', evt: 'MOCK', data: { split: true }, nonce: 'split-1' });
    mock.sendRaw(mock.sockets[0], bytes.subarray(0, 5));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(client.describe().state, 'connected');
    mock.sendRaw(mock.sockets[0], bytes.subarray(5));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The split frame was a server command; it must not corrupt the stream.
    assert.equal(client.describe().state, 'connected');
    assert.equal(client.describe().ready, true);
  } finally {
    client.stop();
    await mock.close();
  }
});

test('without a client id nothing is attempted and the reason is reported', () => {
  const client = new DiscordIpc({ clientId: '   ', candidates: [] });
  client.start();
  assert.equal(client.describe().state, 'unconfigured');
  assert.match(client.describe().detail, /application id/);
});

test('stop() clears the presence and releases the socket', async () => {
  const mock = await new MockDiscord().listen();
  const client = makeClient(mock, { minUpdateIntervalMs: 0 });
  try {
    client.start();
    await once(client, 'ready');
    client.setActivity({ details: 'bye' });
    await until(() => mock.commands('SET_ACTIVITY').length === 1);
    client.stop();
    await until(() => mock.commands('SET_ACTIVITY').length === 2);
    assert.equal(mock.activities()[1], null);
    assert.equal(client.describe().state, 'stopped');
  } finally {
    await mock.close();
  }
});

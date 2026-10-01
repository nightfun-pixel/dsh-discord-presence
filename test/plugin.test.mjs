/**
 * End-to-end test of the plugin body.
 *
 * A fake Cordis context drives the real `apply()`; a mock Discord server stands in
 * for the desktop client; a local HTTP server stands in for a channel webhook. The
 * only things not exercised are the real Discord handshake and a real webhook.
 *
 * Run: node plugins/discord-presence/test/plugin.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { MockDiscord, until } from './mock-discord.mjs';

const plugin = await import('../index.js');

/** A throwaway directory per test. */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-discord-presence-'));
}

/**
 * The smallest Cordis context this plugin uses: `on`, `get` and `effect`.
 * Events are dispatched by hand, which is exactly what the host does.
 */
function makeCtx(services = {}) {
  const listeners = new Map();
  const disposers = [];
  return {
    on(name, listener) {
      const bucket = listeners.get(name) ?? [];
      bucket.push(listener);
      listeners.set(name, bucket);
      return () => {};
    },
    get(name) {
      return services[name];
    },
    effect(execute) {
      disposers.push(execute());
      return { dispose: async () => {} };
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    },
    async dispose() {
      for (const disposer of disposers.reverse()) {
        if (typeof disposer === 'function') disposer();
        else if (disposer !== undefined && typeof disposer.dispose === 'function') await disposer.dispose();
      }
    },
  };
}

/** One session object shaped like the host's. */
function makeSession(id, cwd, header = {}) {
  return {
    id,
    header: { id, createdAt: Date.now(), cwd, ...header },
    requestContext: () => ({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', contextWindow: 1048576 }),
  };
}

/** Wire the plugin to a mock Discord client and a temp status file. */
async function startPlugin(options = {}) {
  const mock = options.mock ?? (await new MockDiscord().listen());
  const directory = tempDir();
  const statusFile = path.join(directory, 'status.json');
  process.env.DSH_DISCORD_PRESENCE_SOCKET = mock.path;
  process.env.DSH_WEB_URL = options.webUrl ?? '';

  try {
    const validation = plugin.Config['~standard'].validate({
      clientId: '123456789012345678',
      statusFilePath: statusFile,
      minUpdateIntervalMs: 0,
      tickIntervalMs: 600000,
      language: 'en',
      ...options.config,
    });
    assert.equal(validation.value !== undefined, true, `config rejected: ${JSON.stringify(validation.issues)}`);

    const ctx = makeCtx(options.services ?? { sessions: { list: () => [] } });
    plugin.apply(ctx);
    // The first SET_ACTIVITY frame is proof the handshake completed: the transport
    // only sends it once Discord answered READY.
    await until(() => mock.commands('SET_ACTIVITY').length >= 1);
    return { mock, ctx, statusFile, directory };
  } catch (error) {
    // A failed start must not leave the mock server listening, or the test run
    // never exits.
    await mock.close();
    throw error;
  }
}

/** The status document as it currently stands on disk. */
function readStatus(statusFile) {
  return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
}

/** The event sequence of one completed turn that ate 1.7k tokens. */
function emitTurn(ctx, session, turn = 1) {
  const at = Date.now();
  ctx.emit('session/event', session, { type: 'turn/start', seq: 1, time: at, data: { turn } });
  ctx.emit('session/event', session, { type: 'user/message', seq: 2, time: at, data: { role: 'user', content: [] } });
  ctx.emit('session/event', session, { type: 'assistant/message', seq: 3, time: at + 100, data: { turn, step: 1, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 } } });
  ctx.emit('session/event', session, { type: 'tool/call', seq: 4, time: at + 200, data: { turn, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' } });
  ctx.emit('session/event', session, { type: 'tool/result', seq: 5, time: at + 300, data: { turn, step: 1 } });
  ctx.emit('session/event', session, { type: 'step/end', seq: 6, time: at + 400, data: { turn, step: 1 } });
  ctx.emit('session/event', session, { type: 'turn/end', seq: 7, time: at + 500, data: { turn, reason: { kind: 'completed' } } });
}

test('the plugin starts, connects, and shows the harness before any session exists', async () => {
  const { mock, ctx, statusFile } = await startPlugin();
  try {
    const activity = mock.activities().at(-1);
    assert.equal(activity.details, 'DeepSeek Harness');
    assert.match(activity.state, /^running · /);

    // The transport reports `connecting` until Discord answers; the status file
    // catches up on the next refresh, which a state change schedules.
    await until(() => readStatus(statusFile).discord.state === 'connected');
    const status = readStatus(statusFile);
    assert.equal(status.discord.state, 'connected');
    assert.equal(status.discord.ready, true);
    assert.equal(status.discord.clientId, 'configured');
    assert.equal(status.sessions.live, 0);
    assert.equal(status.usage, undefined);
  } finally {
    await ctx.dispose();
    await mock.close();
  }
});

test('a session turns the card into a project with tokens and turns', async () => {
  const { mock, ctx, statusFile } = await startPlugin();
  const session = makeSession('session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'D:\\projects\\cool-game');
  try {
    ctx.emit('session/created', session);
    await until(() => mock.activities().some((activity) => activity.details === 'cool-game'));

    emitTurn(ctx, session);
    // Waiting on the last card, not on any card: the session/created refresh already
    // produced one with the same project name.
    await until(() => /1\.7k tokens/.test(mock.activities().at(-1)?.state ?? ''));

    const activity = mock.activities().at(-1);
    assert.equal(activity.details, 'cool-game');
    assert.equal(activity.state, 'deepseek/deepseek-v4.1-flash · 1.7k tokens · 1 turn · 1 tool');
    assert.equal(typeof activity.timestamps.start, 'number');
    assert.match(activity.assets.large_text, /cool-game/);

    const status = readStatus(statusFile);
    assert.equal(status.project.name, 'cool-game');
    assert.equal(status.project.cwd, 'D:\\projects\\cool-game');
    assert.equal(status.project.model, 'deepseek/deepseek-v4.1-flash');
    assert.equal(status.usage.total, 1700);
    assert.equal(status.usage.input, 1200);
    assert.equal(status.usage.output, 500);
    assert.equal(status.usage.source, 'fold');
    assert.deepEqual(status.counts, { turns: 1, steps: 1, tools: 1, retries: 0, interruptions: 0 });
    assert.equal(status.turn.busy, false);
    assert.equal(status.turn.lastEndReason, 'completed');
    assert.equal(status.sessions.active, session.id);
    assert.equal(status.sessions.all[0].project, 'cool-game');
    assert.equal(status.activity.details, 'cool-game');
  } finally {
    await ctx.dispose();
    await mock.close();
  }
});

test('the card shows the model while a turn is open', async () => {
  const { mock, ctx } = await startPlugin();
  const session = makeSession('session-11111111-1111-1111-1111-111111111111', 'D:\\projects\\busy-project');
  try {
    ctx.emit('session/created', session);
    ctx.emit('session/event', session, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } });
    // The card that carries the turn, not the "waiting for a task" one that the
    // session/created refresh sends first.
    await until(() => /0 tokens/.test(mock.activities().at(-1)?.state ?? ''), 3000);
    assert.equal(mock.activities().at(-1).details, 'busy-project');
    assert.match(mock.activities().at(-1).state, /^deepseek\/deepseek-v4\.1-flash · 0 tokens · 1 turn/);
  } finally {
    await ctx.dispose();
    await mock.close();
  }
});

test('a subagent session is counted but never becomes the headline project', async () => {
  const { mock, ctx, statusFile } = await startPlugin();
  const own = makeSession('session-22222222-2222-2222-2222-222222222222', 'D:\\projects\\main-app');
  const child = makeSession('session-33333333-3333-3333-3333-333333333333', 'C:\\Users\\dev\\AppData\\Local\\Temp\\dsh-subagent', {
    origin: 'subagent',
    parentSession: own.id,
    delegationDepth: 1,
  });
  try {
    ctx.emit('session/created', own);
    ctx.emit('session/created', child);
    // The child is busier and more recent; the card must still describe the user's session.
    emitTurn(ctx, child, 1);
    ctx.emit('session/event', child, { type: 'turn/start', seq: 9, time: Date.now() + 1000, data: { turn: 2 } });
    await until(() => readStatus(statusFile).sessions.subagents === 1);

    const status = readStatus(statusFile);
    assert.equal(status.sessions.live, 2);
    assert.equal(status.sessions.active, own.id);
    assert.equal(status.project.name, 'main-app');
    assert.equal(status.sessions.all.find((entry) => entry.id === child.id).subagent, true);
    await until(() => mock.activities().at(-1)?.details?.includes('main-app') === true);
    assert.equal(mock.activities().at(-1).details, 'main-app');
  } finally {
    await ctx.dispose();
    await mock.close();
  }
});

test('the tokenUsage projection wins over the local fold when the composition has one', async () => {
  const services = {
    sessions: { list: () => [] },
    sessionProjections: {
      stateOf: (_session, key) => (key === 'tokenUsage'
        ? { totals: { uncachedInputTokens: 9000, outputTokens: 1000, cacheReadTokens: 100, cacheWriteTokens: 0 }, last: null }
        : undefined),
    },
  };
  const { mock, ctx, statusFile } = await startPlugin({ services });
  const session = makeSession('session-44444444-4444-4444-4444-444444444444', 'D:\\projects\\big-context');
  try {
    ctx.emit('session/created', session);
    emitTurn(ctx, session);
    await until(() => readStatus(statusFile).usage?.source === 'projection');
    const status = readStatus(statusFile);
    assert.equal(status.usage.total, 10100);
    assert.equal(status.usage.input, 9100);
    assert.equal(status.turn.tokens, 1700, 'the per-turn figure still comes from the fold');
  } finally {
    await ctx.dispose();
    await mock.close();
  }
});

test('a session that already existed is picked up, with its route read from the session', async () => {
  const existing = makeSession('session-55555555-5555-5555-5555-555555555555', 'D:\\projects\\already-running');
  const { mock, ctx, statusFile } = await startPlugin({ services: { sessions: { list: () => [existing] } } });
  try {
    await until(() => readStatus(statusFile).sessions.live === 1);
    const status = readStatus(statusFile);
    assert.equal(status.sessions.active, existing.id);
    assert.equal(status.project.model, 'deepseek/deepseek-v4.1-flash', 'the durable route names the model without any event');
  } finally {
    await ctx.dispose();
    await mock.close();
  }
});

test('the webhook receives one embed per finished turn, and its URL is redacted in the status file', async () => {
  const received = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received.push({ url: request.url, body: JSON.parse(body) });
      response.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const { mock, ctx, statusFile } = await startPlugin({ config: { webhookUrl: `http://127.0.0.1:${port}/hook` } });
  const session = makeSession('session-66666666-6666-6666-6666-666666666666', 'D:\\projects\\hooked');
  try {
    ctx.emit('session/created', session);
    emitTurn(ctx, session);
    await until(() => received.length === 1, 5000);

    const embed = received[0].body.embeds[0];
    assert.equal(received[0].url, '/hook');
    assert.match(embed.title, /hooked — completed/);
    assert.equal(embed.color, 0x57f287);
    assert.equal(embed.fields.find((field) => field.name.startsWith('tokens (turn)')).value, '1.7k');
    assert.equal(embed.footer.text, `session ${session.id.slice(-8)}`);

    await until(() => readStatus(statusFile).webhook.sent === 1);
    const status = readStatus(statusFile);
    assert.equal(status.webhook.configured, true);
    assert.equal(status.webhook.looksLikeDiscord, false);
    assert.equal(status.webhook.host, `127.0.0.1:${port}`);
    assert.equal(JSON.stringify(status).includes('/hook'), false, 'the webhook path must not leak into the status file');
  } finally {
    await ctx.dispose();
    await mock.close();
    await closeServer(server);
  }
});

/** Close a local HTTP receiver, dropping keep-alive connections so the run can end. */
function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

test('a session start is posted only when the setting asks for it', async () => {
  const received = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received.push(JSON.parse(body));
      response.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const { mock, ctx } = await startPlugin({
    config: { webhookUrl: `http://127.0.0.1:${port}/hook`, webhookOnSessionStart: true, webhookOnTurnEnd: false },
  });
  try {
    ctx.emit('session/created', makeSession('session-77777777-7777-7777-7777-777777777777', 'D:\\projects\\announced'));
    await until(() => received.length === 1, 5000);
    assert.match(received[0].embeds[0].title, /announced — started/);
  } finally {
    await ctx.dispose();
    await mock.close();
    await closeServer(server);
  }
});

test('disposing the plugin clears the card and stops the transport', async () => {
  const { mock, ctx } = await startPlugin();
  const session = makeSession('session-88888888-8888-8888-8888-888888888888', 'D:\\projects\\goodbye');
  try {
    ctx.emit('session/created', session);
    await until(() => mock.activities().some((activity) => activity.details === 'goodbye'));

    await ctx.dispose();
    await until(() => mock.activities().at(-1) === null);
    assert.equal(mock.activities().at(-1), null, 'a cleared presence is an explicit null activity');
  } finally {
    await mock.close();
  }
});

test('the plugin survives a Discord client that refuses the application id', async () => {
  const mock = await new MockDiscord({ behavior: 'close', closeCode: 4000 }).listen();
  const directory = tempDir();
  process.env.DSH_DISCORD_PRESENCE_SOCKET = mock.path;
  const validation = plugin.Config['~standard'].validate({
    clientId: '000000000000000000',
    statusFilePath: path.join(directory, 'status.json'),
    tickIntervalMs: 600000,
  });
  assert.equal(validation.value !== undefined, true);
  const ctx = makeCtx({ sessions: { list: () => [] } });
  try {
    plugin.apply(ctx);
    await until(() => readStatus(path.join(directory, 'status.json')).discord.state === 'invalid-client-id');
    const status = readStatus(path.join(directory, 'status.json'));
    assert.match(status.discord.detail, /Invalid Client ID/);
    assert.equal(status.discord.ready, false);
    // The harness keeps working: the status file is still written on every refresh.
    ctx.emit('session/created', makeSession('session-99999999-9999-9999-9999-999999999999', 'D:\\projects\\unaffected'));
    await until(() => readStatus(path.join(directory, 'status.json')).project?.name === 'unaffected');
  } finally {
    await ctx.dispose();
    await mock.close();
  }
});

test('an invalid setting is rejected with an issue instead of being stored', () => {
  const validation = plugin.Config['~standard'].validate({ language: 'klingon', minUpdateIntervalMs: 9999999 });
  assert.equal(validation.value, undefined);
  const paths = validation.issues.map((issue) => issue.path[0]).sort();
  assert.deepEqual(paths, ['language', 'minUpdateIntervalMs']);
});

test('the config schema is Schemastery-shaped enough for the settings page', () => {
  const schema = plugin.Config;
  assert.equal(schema[Symbol.for('schemastery')], true);
  assert.equal(schema.type, 'object');
  assert.equal(typeof schema.meta, 'object');
  assert.equal(Object.keys(schema.dict).length, 19);

  const json = plugin.Config.toJSON();
  assert.equal(typeof json.uid, 'number');
  const root = json.refs[json.uid];
  assert.equal(root.type, 'object');
  const fields = Object.values(root.dict).map((uid) => json.refs[uid]);
  assert.equal(fields.length, 19);
  assert.equal(fields.every((node) => node.meta.volatile === true), true, 'every field must be live-editable');
  assert.equal(fields.every((node) => node.meta.default !== undefined), true, 'every field needs a default for the card');
  assert.equal(fields.filter((node) => node.type === 'boolean').length, 9);
  assert.equal(fields.filter((node) => node.type === 'number').length, 2);
});

test('the module exports the plugin shape Cordis expects', () => {
  assert.equal(plugin.name, 'discord-presence');
  assert.deepEqual(plugin.inject, []);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(typeof plugin.Config, 'object');
});

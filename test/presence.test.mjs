/**
 * Tests for the accounting and formatting layers: no host, no Discord, no clock.
 *
 * Run: node plugins/discord-presence/test/presence.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addUsage,
  applyEvent,
  createSessionState,
  emptyUsage,
  isSubagent,
  pickActiveSession,
  projectName,
  readProjectedUsage,
  totalTokens,
} from '../lib/session-tracker.js';
import {
  buildActivity,
  buildWebhookBody,
  clip,
  formatDuration,
  formatTokens,
  plural,
  renderTemplate,
  STRINGS,
  summarize,
  templateVars,
} from '../lib/presence.js';

/** The settings shape `validateConfig` produces, with test overrides. */
function config(overrides = {}) {
  return {
    enabled: true,
    clientId: '123456789012345678',
    language: 'en',
    showModel: true,
    showTokens: true,
    showTurns: true,
    showTools: true,
    detailsTemplate: '',
    stateTemplate: '',
    largeImage: '',
    largeText: '',
    showButton: false,
    webhookUrl: '',
    webhookOnTurnEnd: true,
    webhookOnSessionStart: false,
    statusFile: true,
    statusFilePath: '',
    minUpdateIntervalMs: 15000,
    tickIntervalMs: 30000,
    ...overrides,
  };
}

/** A session object shaped like the host's, with a 1.7k-token history. */
function session(overrides = {}) {
  const createdAt = overrides.createdAt ?? 1_700_000_060_000;
  return {
    id: 'session-11111111-2222-3333-4444-555555555555',
    header: { createdAt, cwd: 'D:\\projects\\cool-game', id: 'session-11111111-2222-3333-4444-555555555555', ...overrides.header },
    ...overrides.session,
  };
}

/** The state a session reaches after one busy turn that ate 1.7k tokens. */
function tracked(overrides = {}) {
  const state = createSessionState(session(overrides), 1_700_000_000_000);
  applyEvent(state, { type: 'turn/start', time: 1_700_000_060_000, data: { turn: 1 } });
  applyEvent(state, { type: 'request/context', time: 1_700_000_060_100, data: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', contextWindow: 1048576 } });
  applyEvent(state, { type: 'assistant/message', time: 1_700_000_061_000, data: { usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 } } });
  applyEvent(state, { type: 'tool/call', time: 1_700_000_062_000, data: { callId: 'a', name: 'pwsh' } });
  applyEvent(state, { type: 'tool/call', time: 1_700_000_062_500, data: { callId: 'b', name: 'read' } });
  applyEvent(state, { type: 'step/end', time: 1_700_000_063_000, data: { turn: 1, step: 1 } });
  return state;
}

/** An env snapshot as `index.js` builds it. */
function env(active, overrides = {}) {
  const now = overrides.now ?? 1_700_000_120_000;
  return {
    now,
    harnessStartedAt: overrides.harnessStartedAt ?? 1_700_000_000_000,
    active,
    live: overrides.live ?? (active === undefined ? 0 : 1),
    subagents: overrides.subagents ?? 0,
    sessions: overrides.sessions ?? (active === undefined ? [] : [active]),
    webUrl: overrides.webUrl ?? '',
    discord: overrides.discord ?? { state: 'connected', detail: 'ready' },
    config: overrides.config ?? config(),
    usageSource: 'fold',
  };
}

test('the event fold counts turns, steps, tools and tokens', () => {
  const state = tracked();
  assert.equal(state.turns, 1);
  assert.equal(state.steps, 1);
  assert.equal(state.toolCalls, 2);
  assert.equal(state.busy, true, 'turn/start opens the turn');
  assert.equal(state.provider, 'openrouter');
  assert.equal(state.model, 'deepseek/deepseek-v4.1-flash');
  assert.equal(state.contextWindow, 1048576);
  assert.equal(totalTokens(state.usage), 1700);
  assert.equal(state.usage.uncachedInput, 1000);
  assert.equal(state.usage.cacheRead, 200);
  assert.equal(state.usage.output, 500);
  assert.equal(state.lastEventType, 'step/end');
});

test('turn/end closes the turn, records its reason, and resets the per-turn counter', () => {
  const state = tracked();
  assert.equal(totalTokens(state.turnUsage), 1700);
  applyEvent(state, { type: 'turn/end', time: 1_700_000_070_000, data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(state.busy, false);
  assert.equal(state.lastTurnEndReason, 'completed');
  assert.equal(totalTokens(state.usage), 1700, 'session totals survive the turn boundary');

  applyEvent(state, { type: 'turn/start', time: 1_700_000_080_000, data: { turn: 2 } });
  assert.equal(totalTokens(state.turnUsage), 0, 'a new turn starts from zero');
  assert.equal(totalTokens(state.usage), 1700);
});

test('usage accumulates across model calls, and absent fields are tolerated', () => {
  const state = createSessionState(session(), 1_700_000_000_000);
  applyEvent(state, { type: 'assistant/message', time: 1, data: { usage: { inputTokens: 10, outputTokens: 2 } } });
  applyEvent(state, { type: 'assistant/message', time: 2, data: { usage: { inputTokens: 5, outputTokens: 1, cacheWriteTokens: 4, reasoningTokens: 3 } } });
  applyEvent(state, { type: 'assistant/message', time: 3, data: {} });
  applyEvent(state, { type: 'assistant/message', time: 4, data: { usage: { inputTokens: -5, outputTokens: Number.NaN } } });
  assert.equal(state.usage.uncachedInput, 15);
  assert.equal(state.usage.output, 3);
  assert.equal(state.usage.cacheWrite, 4);
  assert.equal(state.usage.reasoning, 3, 'reasoning is tracked but not part of the billed total');
  assert.equal(totalTokens(state.usage), 22);
});

test('an interrupted assistant message is counted as an interruption', () => {
  const state = createSessionState(session(), 1);
  applyEvent(state, { type: 'assistant/message', time: 2, data: { usage: { inputTokens: 1, outputTokens: 1 }, interrupted: true } });
  assert.equal(state.interruptions, 1);
});

test('unknown event types are ignored rather than fatal', () => {
  const state = createSessionState(session(), 1);
  const before = JSON.stringify(state);
  applyEvent(state, { type: 'something/from/a/plugin', time: 5, data: { whatever: true } });
  assert.equal(state.lastEventType, 'something/from/a/plugin');
  assert.equal(state.turns, 0);
  assert.equal(totalTokens(state.usage), 0);
  assert.notEqual(JSON.stringify(state), before, 'the event timestamp still advances');
});

test('addUsage and totalTokens handle junk input', () => {
  const usage = emptyUsage();
  addUsage(usage, undefined);
  addUsage(usage, null);
  addUsage(usage, 'nonsense');
  assert.equal(totalTokens(usage), 0);
  addUsage(usage, { inputTokens: 3 });
  assert.equal(totalTokens(usage), 3);
});

test('readProjectedUsage prefers the projection, and never throws', () => {
  const fakeSession = session();
  assert.equal(readProjectedUsage(undefined, fakeSession), undefined);

  const throwing = { stateOf() { throw new Error('token meter not mounted'); } };
  assert.equal(readProjectedUsage(throwing, fakeSession), undefined);

  const wired = {
    stateOf: (_session, key) => (key === 'tokenUsage'
      ? { totals: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1 }, last: null }
      : undefined),
  };
  assert.deepEqual(readProjectedUsage(wired, fakeSession), { uncachedInput: 100, output: 20, cacheRead: 5, cacheWrite: 1, reasoning: 0 });

  const zeros = { stateOf: () => ({ totals: { uncachedInputTokens: 0, outputTokens: 0 } }) };
  assert.equal(readProjectedUsage(zeros, fakeSession), undefined, 'an unfolded meter must not report a suspicious zero');
});

test('pickActiveSession prefers the user session over a busier subagent', () => {
  const own = tracked();
  own.lastEventAt = 1_700_000_100_000;
  const child = createSessionState(session({ header: { origin: 'subagent', parentSession: 'session-parent', createdAt: 1_700_000_000_000 } }), 1_700_000_000_000);
  child.lastEventAt = 1_700_000_200_000;
  assert.equal(isSubagent(child), true);

  const census = pickActiveSession([own, child]);
  assert.equal(census.active, own, 'a delegated child is not the project on the card');
  assert.equal(census.live, 2);
  assert.equal(census.subagents, 1);

  const onlyChild = pickActiveSession([child]);
  assert.equal(onlyChild.active, child, 'with nothing else running, the child is still shown');
});

test('projectName reads the workspace title, then the last path segment', () => {
  assert.equal(projectName(tracked()), 'cool-game');
  const titled = tracked();
  titled.projectTitle = 'My Game';
  assert.equal(projectName(titled), 'My Game');
  const trailing = tracked();
  trailing.cwd = 'D:\\projects\\cool-game\\';
  assert.equal(projectName(trailing), 'cool-game');
  const posix = tracked();
  posix.cwd = '/home/dev/app';
  assert.equal(projectName(posix), 'app');
  assert.equal(projectName(undefined), undefined);
  assert.equal(projectName(createSessionState({ id: 'x', header: {} }, 1)), undefined);
});

test('formatDuration and formatTokens stay short', () => {
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(12 * 60_000 + 30_000), '12m 30s');
  assert.equal(formatDuration(3 * 3_600_000 + 7 * 60_000), '3h 07m');
  assert.equal(formatDuration(2 * 86_400_000 + 4 * 3_600_000), '2d 04h');
  assert.equal(formatDuration(45_000, STRINGS.ru), '45с');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(842), '842');
  assert.equal(formatTokens(1700), '1.7k');
  assert.equal(formatTokens(45200), '45.2k');
  assert.equal(formatTokens(1000), '1k');
  assert.equal(formatTokens(1_240_000), '1.24M');
});

test('plural picks the Russian form', () => {
  const words = STRINGS.ru.turnWords;
  assert.equal(plural(1, words, true), 'ход');
  assert.equal(plural(2, words, true), 'хода');
  assert.equal(plural(5, words, true), 'ходов');
  assert.equal(plural(11, words, true), 'ходов');
  assert.equal(plural(21, words, true), 'ход');
  assert.equal(plural(1, STRINGS.en.turnWords, false), 'turn');
  assert.equal(plural(3, STRINGS.en.turnWords, false), 'turns');
});

test('renderTemplate drops the segments whose placeholders came out empty', () => {
  assert.equal(renderTemplate('{status} {project}', { status: 'working', project: 'app' }), 'working app');
  assert.equal(renderTemplate('{project} {missing}', { project: 'app' }), 'app', 'a blank placeholder leaves no stray space');
  assert.equal(renderTemplate('{model} · {tokens} tokens', { model: '', tokens: '1.7k' }), '1.7k tokens');
  assert.equal(renderTemplate('a · b · c', {}), 'a · b · c');
  assert.equal(renderTemplate('{missing}', {}), '');
  assert.equal(clip('x'.repeat(200)).length, 128);
  assert.equal(renderTemplate('{a}'.repeat(300), { a: 'y' }).length, 128);
});

test('the card without a session says the harness is on', () => {
  const snapshot = env(undefined, { now: 1_700_000_300_000 });
  const { activity, texts } = buildActivity(snapshot, config());
  assert.equal(texts.details, 'DeepSeek Harness');
  assert.equal(texts.state, 'running · 5m 00s');
  assert.equal(activity.timestamps.start, 1_700_000_000_000);
  assert.equal(activity.buttons, undefined);
  assert.equal(summarize(snapshot), 'DeepSeek Harness — running · 5m 00s');
});

test('the card with a session shows project, model, tokens and turns', () => {
  const state = tracked();
  state.busy = false;
  const snapshot = env(state, { now: 1_700_000_120_000 });
  const { activity, texts } = buildActivity(snapshot, config());
  assert.equal(texts.details, 'cool-game');
  assert.equal(texts.state, 'deepseek/deepseek-v4.1-flash · 1.7k tokens · 1 turn · 2 tools');
  assert.equal(activity.timestamps.start, 1_700_000_060_000, 'the timer starts when the session did');
  assert.equal(activity.assets.large_image, undefined);
  assert.match(activity.assets.large_text, /cool-game · 1 turn · 2 tools · session 55555555/);
});

test('the elapsed timer is clamped to this harness run', () => {
  const state = tracked({ createdAt: 1_600_000_000_000 });
  const snapshot = env(state, { harnessStartedAt: 1_700_000_000_000 });
  const { activity } = buildActivity(snapshot, config());
  assert.equal(activity.timestamps.start, 1_700_000_000_000, 'a restored old session must not claim months of work');
});

test('a session that has not done anything yet names the wait instead of showing zeroes', () => {
  const fresh = createSessionState(session(), 1_700_000_060_000);
  const { texts } = buildActivity(env(fresh, { now: 1_700_000_120_000 }), config());
  assert.equal(texts.details, 'cool-game');
  assert.equal(texts.state, 'waiting for a task');
  assert.equal(buildActivity(env(fresh), config({ language: 'ru' })).texts.state, 'ожидание задачи');
});

test('the toggles remove fields instead of blanking them', () => {
  const state = tracked();
  state.busy = false;
  const snapshot = env(state, { now: 1_700_000_120_000 });
  const { texts } = buildActivity(snapshot, config({ showModel: false, showTools: false }));
  assert.equal(texts.state, '1.7k tokens · 1 turn');

  const bare = buildActivity(snapshot, config({ showModel: false, showTokens: false, showTurns: false, showTools: false }));
  assert.equal(bare.texts.state, 'idle');
});

test('the card speaks Russian when asked', () => {
  const state = tracked();
  state.busy = true;
  const snapshot = env(state, { config: config({ language: 'ru' }) });
  const { texts } = buildActivity(snapshot, config({ language: 'ru' }));
  assert.equal(texts.details, 'cool-game');
  assert.equal(texts.state, 'deepseek/deepseek-v4.1-flash · 1.7k токенов · 1 ход · 2 инструмента');
});

test('templates override the built-in rows and can use every placeholder', () => {
  const state = tracked();
  state.busy = true;
  const settings = config({
    detailsTemplate: '{project} ({provider})',
    stateTemplate: '{status} · {elapsed} · {tokensIn}/{tokensOut} · {session} · {uptime} · {sessions}/{subagents}',
  });
  const { texts } = buildActivity(env(state, { now: 1_700_000_120_000, subagents: 2, live: 3 }), settings);
  assert.equal(texts.details, 'cool-game (openrouter)');
  assert.equal(texts.state, 'working · 1m 00s · 1.2k/500 · 55555555 · 2m 00s · 3/2');
});

test('a configured image and button reach the payload, and an unset one does not', () => {
  const state = tracked();
  const plain = buildActivity(env(state), config());
  assert.equal(plain.activity.assets.large_image, undefined);
  assert.equal(plain.activity.buttons, undefined);

  const rich = buildActivity(
    env(state, { webUrl: 'http://127.0.0.1:3080' }),
    config({ largeImage: 'harness', largeText: 'DSH', showButton: true }),
  );
  assert.equal(rich.activity.assets.large_image, 'harness');
  assert.equal(rich.activity.assets.large_text, 'DSH');
  assert.deepEqual(rich.activity.buttons, [{ label: 'Open DSH', url: 'http://127.0.0.1:3080' }]);

  const noUrl = buildActivity(env(state, { webUrl: '' }), config({ showButton: true }));
  assert.equal(noUrl.activity.buttons, undefined, 'a button without a URL is not a button');

  const russianButton = buildActivity(env(state, { webUrl: 'http://127.0.0.1:3080' }), config({ showButton: true, language: 'ru' }));
  assert.equal(russianButton.activity.buttons[0].label, 'Открыть DSH');
});

test('every rendered row stays inside Discord limits', () => {
  const state = tracked();
  state.cwd = `D:\\${'very-long-segment\\'.repeat(20)}project`;
  const snapshot = env(state);
  const { activity, texts } = buildActivity(snapshot, config({ detailsTemplate: '{workspace}', stateTemplate: '{workspace}' }));
  assert.equal(texts.details.length <= 128, true);
  assert.equal(texts.state.length <= 128, true);
  assert.equal(activity.assets.large_text.length <= 128, true);
});

test('templateVars exposes the documented placeholders', () => {
  const state = tracked();
  const vars = templateVars({ ...env(state), config: config() });
  assert.deepEqual(Object.keys(vars).sort(), [
    'agent', 'discord', 'elapsed', 'model', 'project', 'provider', 'session',
    'sessions', 'status', 'steps', 'subagents', 'tokens', 'tokensIn', 'tokensOut',
    'tools', 'turns', 'uptime', 'workspace',
  ]);
});

test('the webhook embed reports the turn that just finished', () => {
  const state = tracked();
  applyEvent(state, { type: 'turn/end', time: 1_700_000_070_000, data: { turn: 1, reason: { kind: 'completed' } } });
  const snapshot = env(state, { now: 1_700_000_120_000 });
  const body = buildWebhookBody(snapshot, config());
  assert.equal(body.embeds[0].color, 0x57f287);
  assert.match(body.embeds[0].title, /cool-game — completed/);
  const names = body.embeds[0].fields.map((field) => field.name);
  assert.deepEqual(names, ['tokens (turn)', 'tokens (total)', 'turns', 'model', 'cwd']);
  assert.equal(body.embeds[0].fields[0].value, '1.7k');
  assert.equal(body.embeds[0].footer.text, 'session 55555555');

  const failed = tracked();
  applyEvent(failed, { type: 'turn/end', time: 1_700_000_070_000, data: { turn: 1, reason: { kind: 'error', error: {} } } });
  assert.equal(buildWebhookBody(env(failed), config()).embeds[0].color, 0xed4245);
});

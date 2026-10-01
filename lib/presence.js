/**
 * Turning tracked numbers into the two short lines Discord actually renders.
 *
 * Discord gives a Rich Presence card exactly two text rows — `details` and
 * `state`, 128 characters each — plus a self-ticking elapsed timer, an optional
 * image with a hover tooltip, and optional link buttons. Everything in this file
 * exists to fill those five slots well, and to stay pure so it can be tested
 * without a Discord client.
 *
 * @module discord-presence/lib/presence
 */

import { projectName, totalTokens } from './session-tracker.js';

/**
 * Every user-visible string.
 *
 * `turns` and `tools` are labels (used in webhook field names); the `*Words` arrays
 * are the three Russian plural forms, or `[one, many]` doubled for English.
 */
export const STRINGS = {
  ru: {
    harness: 'DeepSeek Harness',
    running: 'запущен',
    working: 'работает',
    idle: 'простаивает',
    tokens: 'токенов',
    turns: 'ходы',
    tools: 'инструменты',
    turnWords: ['ход', 'хода', 'ходов'],
    toolWords: ['инструмент', 'инструмента', 'инструментов'],
    session: 'сессия',
    subagents: 'субагенты',
    waiting: 'ожидание задачи',
    openButton: 'Открыть DSH',
    reasons: {
      completed: 'завершён',
      error: 'ошибка',
      aborted: 'прерван',
      blocked: 'заблокирован',
      'max-tokens': 'лимит токенов',
      interrupted: 'прерван',
      forked: 'форк',
    },
  },
  en: {
    harness: 'DeepSeek Harness',
    running: 'running',
    working: 'working',
    idle: 'idle',
    tokens: 'tokens',
    turns: 'turns',
    tools: 'tools',
    turnWords: ['turn', 'turns', 'turns'],
    toolWords: ['tool', 'tools', 'tools'],
    session: 'session',
    subagents: 'subagents',
    waiting: 'waiting for a task',
    openButton: 'Open DSH',
    reasons: {
      completed: 'completed',
      error: 'error',
      aborted: 'aborted',
      blocked: 'blocked',
      'max-tokens': 'max tokens',
      interrupted: 'interrupted',
      forked: 'forked',
    },
  },
};

/** Discord's hard limit on a presence text row. */
export const TEXT_LIMIT = 128;

/**
 * Pick the grammatical form for a count.
 *
 * @param {number} n - the count.
 * @param {[string, string, string]} forms - one / few / many, or `[one, many, many]` for English.
 * @param {boolean} ru - whether the Russian rules apply.
 * @returns {string} the matching form.
 */
export function plural(n, forms, ru) {
  if (!ru) return n === 1 ? forms[0] : forms[1];
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

/**
 * Human-readable duration, coarse on purpose: the card already carries a ticking
 * timer, so this string only has to survive tooltips and webhook embeds.
 *
 * @param {number} ms - a non-negative duration.
 * @param {object} [strings] - one {@link STRINGS} entry.
 * @returns {string} e.g. `45s`, `12m 30s`, `3h 07m`, `2d 04h`.
 */
export function formatDuration(ms, strings = STRINGS.en) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const ru = strings !== STRINGS.en;
  if (seconds < 60) return `${seconds}${ru ? 'с' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${ru ? 'м' : 'm'} ${String(seconds % 60).padStart(2, '0')}${ru ? 'с' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${ru ? 'ч' : 'h'} ${String(minutes % 60).padStart(2, '0')}${ru ? 'м' : 'm'}`;
  const days = Math.floor(hours / 24);
  return `${days}${ru ? 'д' : 'd'} ${String(hours % 24).padStart(2, '0')}${ru ? 'ч' : 'h'}`;
}

/**
 * Compact token count: the card has room for four or five characters.
 * @param {number} value - a token count.
 * @returns {string} e.g. `842`, `45.2k`, `1.24M`.
 */
export function formatTokens(value) {
  const n = Math.max(0, Math.round(value));
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(1).replace(/\.0$/u, '')}k`;
  return `${(n / 1000000).toFixed(2).replace(/\.?0+$/u, '')}M`;
}

/**
 * Clip text to Discord's limit, marking a cut.
 * @param {string} text - the candidate text.
 * @param {number} [limit] - maximum length.
 * @returns {string} the clipped text.
 */
export function clip(text, limit = TEXT_LIMIT) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Substitute `{placeholders}` and drop the segments that came out empty.
 *
 * Templates are written as `a · b · c`; a segment whose placeholders all resolve
 * empty would otherwise leave a dangling separator, so segments are joined rather
 * than concatenated. A template with no `·` is a single segment and is unaffected.
 *
 * @param {string} template - text with `{name}` placeholders.
 * @param {Record<string, string|number|undefined>} vars - placeholder values.
 * @returns {string} the rendered text, trimmed and clipped.
 */
export function renderTemplate(template, vars) {
  const rendered = template.replace(/\{(\w+)\}/gu, (_match, name) => {
    const value = vars[name];
    return value === undefined || value === null ? '' : String(value);
  });
  const segments = rendered
    .split('·')
    .map((segment) => segment.replace(/\s+/gu, ' ').trim())
    .filter((segment) => segment.length > 0);
  return clip(segments.join(' · '));
}

/**
 * The placeholder values available to `detailsTemplate`, `stateTemplate` and
 * `largeText`, documented in the README.
 *
 * @param {object} env - the snapshot described in {@link buildActivity}.
 * @returns {Record<string, string|number>} placeholder values.
 */
export function templateVars(env) {
  const strings = STRINGS[env.config.language] ?? STRINGS.en;
  const active = env.active;
  const usage = active?.effectiveUsage ?? active?.usage;
  const start = activityStart(env);
  return {
    project: projectName(active) ?? strings.harness,
    workspace: active?.cwd ?? '',
    model: active?.model ?? '',
    provider: active?.provider ?? '',
    tokens: formatTokens(usage === undefined ? 0 : totalTokens(usage)),
    tokensIn: formatTokens(usage === undefined ? 0 : usage.uncachedInput + usage.cacheRead + usage.cacheWrite),
    tokensOut: formatTokens(usage === undefined ? 0 : usage.output),
    turns: active?.turns ?? 0,
    steps: active?.steps ?? 0,
    tools: active?.toolCalls ?? 0,
    session: active === undefined ? '' : String(active.id).slice(-8),
    agent: active?.agentPreset ?? '',
    status: active === undefined ? strings.waiting : active.busy ? strings.working : strings.idle,
    elapsed: formatDuration(env.now - start, strings),
    uptime: formatDuration(env.now - env.harnessStartedAt, strings),
    sessions: env.live,
    subagents: env.subagents,
    discord: env.discord?.state ?? '',
  };
}

/**
 * When the card's elapsed timer starts.
 *
 * A session's own creation time is the honest answer for a session this harness
 * run created. A session restored from an older run would otherwise claim days of
 * elapsed work, so the timer is clamped to the moment this process started.
 *
 * @param {object} env - the snapshot.
 * @returns {number} epoch milliseconds.
 */
export function activityStart(env) {
  const sessionStart = env.active?.createdAt ?? env.harnessStartedAt;
  return Math.max(sessionStart, env.harnessStartedAt);
}

/**
 * The default `state` row, assembled from the enabled fields so the card never
 * shows a placeholder for a number the user asked to hide.
 *
 * @param {object} env - the snapshot.
 * @param {object} strings - one {@link STRINGS} entry.
 * @returns {string} the state text.
 */
function defaultStateText(env, strings) {
  const ru = strings === STRINGS.ru;
  const active = env.active;
  if (active === undefined) return `${strings.running} · {uptime}`;
  // A session that has not done anything yet has no numbers worth showing; naming
  // the wait reads better than "0 tokens".
  if (active.turns === 0 && active.toolCalls === 0 && totalTokens(active.effectiveUsage ?? active.usage) === 0) {
    return strings.waiting;
  }
  const parts = [];
  if (env.config.showModel && active.model !== undefined) parts.push(active.model);
  if (env.config.showTokens) parts.push(`${formatTokens(totalTokens(active.effectiveUsage ?? active.usage))} ${strings.tokens}`);
  if (env.config.showTurns && active.turns > 0) parts.push(`${active.turns} ${plural(active.turns, strings.turnWords, ru)}`);
  if (env.config.showTools && active.toolCalls > 0) parts.push(`${active.toolCalls} ${plural(active.toolCalls, strings.toolWords, ru)}`);
  if (parts.length === 0) parts.push(active.busy ? strings.working : strings.idle);
  return clip(parts.join(' · '));
}

/**
 * The default hover tooltip for the card's image.
 * @param {object} env - the snapshot.
 * @param {object} strings - one {@link STRINGS} entry.
 * @returns {string} the tooltip text.
 */
function defaultLargeText(env, strings) {
  const ru = strings === STRINGS.ru;
  const active = env.active;
  if (active === undefined) {
    const uptime = formatDuration(env.now - env.harnessStartedAt, strings);
    return clip(`${strings.harness} · ${strings.running} · ${uptime}`);
  }
  const parts = [
    projectName(active) ?? strings.harness,
    `${active.turns} ${plural(active.turns, strings.turnWords, ru)}`,
    `${active.toolCalls} ${plural(active.toolCalls, strings.toolWords, ru)}`,
    `${strings.session} ${String(active.id).slice(-8)}`,
  ];
  return clip(parts.join(' · '));
}

/**
 * Build the Discord activity payload plus the texts it was built from.
 *
 * @param {object} env - the snapshot to render.
 * @param {number} env.now - current epoch milliseconds.
 * @param {number} env.harnessStartedAt - when this harness process started.
 * @param {object|undefined} env.active - the session being described, if any.
 * @param {number} env.live - live session count, including subagents.
 * @param {number} env.subagents - delegated child count.
 * @param {string} [env.webUrl] - the harness web URL, for the optional button.
 * @param {{ state: string, detail: string }} [env.discord] - transport status.
 * @param {object} config - resolved plugin settings.
 * @returns {{ activity: object, texts: { details: string, state: string, largeText?: string } }} the payload and its texts.
 */
export function buildActivity(env, config) {
  const strings = STRINGS[config.language] ?? STRINGS.en;
  const vars = templateVars({ ...env, config });

  const detailsTemplate = config.detailsTemplate.trim().length > 0 ? config.detailsTemplate : '{project}';
  const details = renderTemplate(detailsTemplate, vars);
  // The built-in row goes through the same substitution as a user template: the
  // no-session wording carries a `{uptime}` placeholder of its own.
  const state = renderTemplate(
    config.stateTemplate.trim().length > 0 ? config.stateTemplate : defaultStateText({ ...env, config }, strings),
    vars,
  );

  const activity = {
    details,
    state,
    timestamps: { start: activityStart(env) },
  };

  const largeImage = config.largeImage.trim();
  const largeText = config.largeText.trim().length > 0
    ? renderTemplate(config.largeText, vars)
    : defaultLargeText(env, strings);
  if (largeImage.length > 0 || largeText.length > 0) {
    activity.assets = {
      ...(largeImage.length > 0 ? { large_image: largeImage } : {}),
      ...(largeText.length > 0 ? { large_text: largeText } : {}),
    };
  }

  const webUrl = typeof env.webUrl === 'string' ? env.webUrl : '';
  if (config.showButton && /^https?:\/\//u.test(webUrl)) {
    activity.buttons = [{ label: strings.openButton, url: webUrl }];
  }

  return { activity, texts: { details, state, largeText } };
}

/**
 * A one-line status for logs and the status file.
 * @param {object} env - the snapshot, carrying its resolved `config`.
 * @returns {string} e.g. `cool-game — deepseek-v4.1-flash · 45.2k tokens · 3 turns`.
 */
export function summarize(env) {
  const { texts } = buildActivity(env, env.config);
  return `${texts.details} — ${texts.state}`;
}

/**
 * The Discord embed used by the optional webhook, one per finished turn.
 *
 * @param {object} env - the snapshot, taken right after `turn/end`.
 * @param {object} config - resolved plugin settings.
 * @returns {object} a webhook body.
 */
export function buildWebhookBody(env, config) {
  const strings = STRINGS[config.language] ?? STRINGS.en;
  const active = env.active;
  const { texts } = buildActivity(env, config);
  const reason = active?.lastTurnEndReason;
  const usage = active?.turnUsage;
  const totals = active?.effectiveUsage ?? active?.usage;
  const color = reason === 'completed' ? 0x57f287 : reason === 'error' ? 0xed4245 : 0x5865f2;
  const reasonText = reason === undefined ? '' : strings.reasons[reason] ?? reason;

  const fields = [];
  if (usage !== undefined) fields.push({ name: `${strings.tokens} (turn)`, value: formatTokens(totalTokens(usage)), inline: true });
  if (totals !== undefined) fields.push({ name: `${strings.tokens} (total)`, value: formatTokens(totalTokens(totals)), inline: true });
  if (active !== undefined) fields.push({ name: strings.turns, value: String(active.turns), inline: true });
  if (active?.model !== undefined) fields.push({ name: 'model', value: active.model, inline: true });
  if (active?.cwd !== undefined) fields.push({ name: 'cwd', value: clip(active.cwd, 1000), inline: false });

  return {
    username: 'DeepSeek Harness',
    embeds: [
      {
        title: clip(`${texts.details} — ${reasonText}`, 256),
        description: clip(texts.state, 4000),
        color,
        fields,
        timestamp: new Date(env.now).toISOString(),
        footer: { text: active === undefined ? strings.harness : `${strings.session} ${String(active.id).slice(-8)}` },
      },
    ],
  };
}

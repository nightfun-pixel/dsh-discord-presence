/**
 * Discord Rich Presence for the DeepSeek Harness.
 *
 * The card Discord renders says four things: that the harness is on, which project
 * it is working on, how long it has been at it, and how many tokens it has eaten —
 * plus a live elapsed timer and an optional "Open DSH" button.
 *
 * How it gets there:
 *
 *   * `ctx.on('session/created' | 'session/event' | 'session/disposed')` is the
 *     whole host integration. Turns, steps, tool calls, the model route and the
 *     provider usage of every model call all arrive on that feed, so this plugin
 *     needs no injected service and keeps working when the composition changes.
 *   * `lib/discord-ipc.js` speaks Discord's local socket protocol directly. No
 *     `discord-rpc` dependency: a profile-installed bundle resolves bare
 *     specifiers from its own directory, which cannot see the dsh installation's
 *     `node_modules`.
 *   * `lib/status-file.js` writes the same numbers to JSON, for anything that is
 *     not Discord.
 *   * `lib/webhook.js` optionally mirrors each finished turn into a channel, which
 *     needs no developer-portal application.
 *
 * Nothing here is allowed to break a turn. Every failure is contained and reported
 * through the status file, and a missing Discord client is a state, not an error.
 *
 * @module dsh-discord-presence
 */

import { DiscordIpc } from './lib/discord-ipc.js';
import { WebhookPoster } from './lib/webhook.js';
import { defaultStatusPath, writeStatusFile } from './lib/status-file.js';
import {
  applyEvent,
  createSessionState,
  pickActiveSession,
  projectName,
  readProjectedUsage,
  totalTokens,
} from './lib/session-tracker.js';
import { buildActivity, buildWebhookBody, formatDuration, formatTokens, STRINGS } from './lib/presence.js';

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'discord-presence';

/**
 * No required services.
 *
 * Everything this plugin reads — the session feed, the projection registry, the
 * workspace registry, the timer service — is optional and reached through
 * `ctx.get()`, which returns `undefined` instead of throwing. That keeps the
 * plugin loadable in a minimal composition and removes any ordering requirement.
 */
export const inject = [];

/** Settings defaults; a row that declares nothing still gets a complete section. */
const DEFAULTS = {
  enabled: true,
  clientId: '',
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
};

/** Languages the card can speak. */
const LANGUAGES = ['ru', 'en'];

/**
 * How often the status file may be rewritten.
 *
 * A turn appends many events; the file only has to be fresh, not instantaneous, so
 * writes are debounced and every transition that matters refreshes immediately.
 */
const STATUS_DEBOUNCE_MS = 1000;

/** Ring buffer size for diagnostics reported through the status file. */
const DIAGNOSTIC_LIMIT = 40;

/**
 * Live settings, written by {@link validateConfig} on every config resolution and
 * read by the plugin at each tick. A settings save re-resolves the row config, so
 * reading through this object makes a save take effect within one tick without a
 * restart.
 */
const current = { ...DEFAULTS };

// ---------------------------------------------------------------------------
// Config: a hand-written native Schemastery graph, matching what the host reads.
//
// The host reads exactly three things off a plugin's Config export:
//   * Cordis mounts the row through the Standard Schema face, `Config['~standard'].validate`.
//   * `dsh-app-boot` recognises the graph by `Symbol.for('schemastery') === true`, a string
//     `type`, and an object `meta`, then walks `dict` to project a JSON Schema.
//   * `dsh-settings` rebuilds a real Schemastery schema from `Config.toJSON()` and keeps the
//     fields whose nearest volatile ancestor makes them live-editable.
//
// Importing schemastery is not an option — a profile-installed bundle cannot see the dsh
// installation's node_modules — so the graph is built by hand.
// ---------------------------------------------------------------------------

/** The key Schemastery brands its schema nodes with; a global symbol, reachable without importing it. */
const SCHEMA_SYMBOL = Symbol.for('schemastery');

/**
 * Build one node of the native schema graph.
 * @param {string} type - Schemastery type name.
 * @param {object} meta - node metadata; `volatile` is what makes a field live-editable.
 * @param {object} [extra] - `dict` for objects, `inner` for arrays.
 * @returns {object} the node.
 */
function schemaNode(type, meta, extra = {}) {
  return {
    [SCHEMA_SYMBOL]: true,
    type,
    meta,
    toJSON() {
      return toSchemaJson(this);
    },
    ...extra,
  };
}

/** One volatile field node with its default and its description. */
function field(type, meta) {
  return schemaNode(type, { volatile: true, ...meta });
}

/** The live-editable settings fields, in the order the settings card lists them. */
const FIELD_NODES = {
  enabled: field('boolean', { default: DEFAULTS.enabled, description: 'Show the harness in Discord at all.' }),
  clientId: field('string', { default: DEFAULTS.clientId, description: 'Discord Application ID from discord.com/developers/applications. Required for Rich Presence.' }),
  language: field('string', { default: DEFAULTS.language, description: 'Card language: ru or en.' }),
  showModel: field('boolean', { default: DEFAULTS.showModel, description: 'Include the model id in the card.' }),
  showTokens: field('boolean', { default: DEFAULTS.showTokens, description: 'Include the token count in the card.' }),
  showTurns: field('boolean', { default: DEFAULTS.showTurns, description: 'Include the turn count in the card.' }),
  showTools: field('boolean', { default: DEFAULTS.showTools, description: 'Include the tool-call count in the card.' }),
  detailsTemplate: field('string', { default: DEFAULTS.detailsTemplate, description: 'Full override for the first row. Placeholders: {project} {workspace} {model} {provider} {tokens} {tokensIn} {tokensOut} {turns} {steps} {tools} {session} {agent} {status} {elapsed} {uptime} {sessions} {subagents} {discord}.' }),
  stateTemplate: field('string', { default: DEFAULTS.stateTemplate, description: 'Full override for the second row. Same placeholders as the first row.' }),
  largeImage: field('string', { default: DEFAULTS.largeImage, description: 'Rich Presence asset key uploaded to the application, or an https image URL. Empty hides the image.' }),
  largeText: field('string', { default: DEFAULTS.largeText, description: 'Hover tooltip for the image. Empty uses a built-in summary.' }),
  showButton: field('boolean', { default: DEFAULTS.showButton, description: 'Add an "Open DSH" button pointing at the harness web URL.' }),
  webhookUrl: field('string', { default: DEFAULTS.webhookUrl, description: 'Optional Discord channel webhook URL; posts one embed per finished turn.' }),
  webhookOnTurnEnd: field('boolean', { default: DEFAULTS.webhookOnTurnEnd, description: 'Post to the webhook when a turn finishes.' }),
  webhookOnSessionStart: field('boolean', { default: DEFAULTS.webhookOnSessionStart, description: 'Post to the webhook when a session starts.' }),
  statusFile: field('boolean', { default: DEFAULTS.statusFile, description: 'Write the machine-readable status JSON file.' }),
  statusFilePath: field('string', { default: DEFAULTS.statusFilePath, description: 'Override the status file path. Empty means <DSH_HOME>/discord-presence/status.json.' }),
  minUpdateIntervalMs: field('number', { step: 1000, min: 0, max: 600000, default: DEFAULTS.minUpdateIntervalMs, description: 'Floor between two Discord presence updates. Discord accepts about five per 20 s; 0 disables the throttle.' }),
  tickIntervalMs: field('number', { step: 1000, min: 5000, max: 600000, default: DEFAULTS.tickIntervalMs, description: 'How often the card and the status file are refreshed with no session activity.' }),
};

/** The root graph: a plain object over those fields. */
const CONFIG_SCHEMA = schemaNode('object', { default: {} }, { dict: FIELD_NODES });

/**
 * Serialize a schema graph the way Schemastery does: a root uid plus a refs table
 * in which every nested node appears as the uid number pointing back into it.
 * Derived from the graph above rather than written out beside it, so the two cannot
 * drift apart.
 *
 * @param {object} root - the graph node to serialize.
 * @returns {{ uid: number, refs: Record<number, object> }} the serialized form.
 */
function toSchemaJson(root) {
  const refs = {};
  const uids = new Map();
  let next = 8100;
  const encode = (node) => {
    const known = uids.get(node);
    if (known !== undefined) return known;
    const uid = next++;
    uids.set(node, uid);
    const plain = { type: node.type, meta: node.meta };
    if (node.dict !== undefined) plain.dict = Object.fromEntries(Object.entries(node.dict).map(([key, child]) => [key, encode(child)]));
    if (node.inner !== undefined) plain.inner = encode(node.inner);
    refs[uid] = plain;
    return uid;
  };
  const uid = encode(root);
  return { uid, refs };
}

/** Reject a value, naming the field and what it accepts. */
function issue(path, value, accepts) {
  return { message: `${path} ${JSON.stringify(value)} is not one of ${accepts.join(', ')}`, path: [path] };
}

/** Read a boolean field, defaulting when absent. */
function readBoolean(input, fieldName, fallback) {
  const value = input[fieldName];
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** Read a string field, defaulting when absent. */
function readString(input, fieldName, fallback) {
  const value = input[fieldName];
  if (value === undefined || value === null) return fallback;
  return typeof value === 'string' ? value.trim() : String(value).trim();
}

/** Read an integer field inside `[min, max]`, recording an issue when it does not fit. */
function readInteger(input, fieldName, fallback, min, max, issues) {
  const value = input[fieldName];
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (Number.isInteger(parsed) && parsed >= min && parsed <= max) return parsed;
  issues.push({ message: `${fieldName} ${JSON.stringify(value)} must be a whole number from ${min} to ${max}`, path: [fieldName] });
  return fallback;
}

/**
 * Normalize one raw config into the live settings section.
 *
 * Defaults are applied, so a row that declares nothing still yields a complete
 * section and the settings card shows the effective value of every field. A value
 * outside the accepted set is an issue rather than a silent fallback: the save that
 * wrote it reports failure instead of storing something the user did not choose.
 *
 * @param {unknown} raw - the row's raw config.
 * @returns {{ value: object } | { issues: object[] }} the resolved section or the problems found.
 */
function validateConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const issues = [];

  const language = readString(input, 'language', DEFAULTS.language).toLowerCase();
  if (!LANGUAGES.includes(language)) issues.push(issue('language', input.language, LANGUAGES));

  const resolved = {
    enabled: readBoolean(input, 'enabled', DEFAULTS.enabled),
    clientId: readString(input, 'clientId', DEFAULTS.clientId),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
    showModel: readBoolean(input, 'showModel', DEFAULTS.showModel),
    showTokens: readBoolean(input, 'showTokens', DEFAULTS.showTokens),
    showTurns: readBoolean(input, 'showTurns', DEFAULTS.showTurns),
    showTools: readBoolean(input, 'showTools', DEFAULTS.showTools),
    detailsTemplate: readString(input, 'detailsTemplate', DEFAULTS.detailsTemplate),
    stateTemplate: readString(input, 'stateTemplate', DEFAULTS.stateTemplate),
    largeImage: readString(input, 'largeImage', DEFAULTS.largeImage),
    largeText: readString(input, 'largeText', DEFAULTS.largeText),
    showButton: readBoolean(input, 'showButton', DEFAULTS.showButton),
    webhookUrl: readString(input, 'webhookUrl', DEFAULTS.webhookUrl),
    webhookOnTurnEnd: readBoolean(input, 'webhookOnTurnEnd', DEFAULTS.webhookOnTurnEnd),
    webhookOnSessionStart: readBoolean(input, 'webhookOnSessionStart', DEFAULTS.webhookOnSessionStart),
    statusFile: readBoolean(input, 'statusFile', DEFAULTS.statusFile),
    statusFilePath: readString(input, 'statusFilePath', DEFAULTS.statusFilePath),
    minUpdateIntervalMs: readInteger(input, 'minUpdateIntervalMs', DEFAULTS.minUpdateIntervalMs, 0, 600000, issues),
    tickIntervalMs: readInteger(input, 'tickIntervalMs', DEFAULTS.tickIntervalMs, 5000, 600000, issues),
  };

  if (issues.length > 0) return { issues };

  Object.assign(current, resolved);
  return { value: resolved };
}

/**
 * The plugin's config schema.
 *
 * `~standard` is the Standard Schema v1 contract Cordis validates through;
 * `meta.volatile` and `toJSON()` are what `dsh-settings` reads to list this entry as
 * a live, editable settings section.
 */
const Config = {
  ...CONFIG_SCHEMA,
  '~standard': {
    version: 1,
    // The client recognises a Schemastery-shaped schema by this exact vendor string and
    // otherwise falls back to a plain comparison. This object IS Schemastery-shaped, so it
    // answers with the same vendor rather than inventing one the client cannot classify.
    vendor: 'schemastery',
    validate: validateConfig,
  },
  toJSON() {
    return toSchemaJson(CONFIG_SCHEMA);
  },
};

export { Config };

// ---------------------------------------------------------------------------
// Plugin body
// ---------------------------------------------------------------------------

/** Compare two filesystem paths, tolerating separator and case differences. */
function samePath(a, b) {
  const normalize = (value) => {
    const unified = value.replace(/[\\/]+/gu, '/').replace(/\/+$/u, '');
    return process.platform === 'win32' ? unified.toLowerCase() : unified;
  };
  return normalize(a) === normalize(b);
}

/**
 * An explicitly named Discord socket, when the environment supplies one.
 *
 * Discord's own socket naming is discovered automatically; this exists for
 * non-standard installs and for pointing the transport at a mock server in tests.
 * @returns {string[]|undefined} a one-element candidate list, or `undefined` to discover.
 */
function socketOverride() {
  const value = process.env.DSH_DISCORD_PRESENCE_SOCKET;
  return typeof value === 'string' && value.trim().length > 0 ? [value.trim()] : undefined;
}

/**
 * Install the plugin.
 * @param {object} ctx - the Cordis context; no service is required.
 */
export function apply(ctx) {
  /** @type {Map<string, object>} tracked numbers per session id. */
  const states = new Map();
  /** @type {Map<string, object>} live Session objects, for projection reads. */
  const live = new Map();
  /** Diagnostics reported through the status file, newest last. */
  const diagnostics = [];

  const harnessStartedAt = Date.now() - Math.round(process.uptime() * 1000);
  const webUrl = process.env.DSH_WEB_URL ?? '';
  const statusPath = () => (current.statusFilePath.length > 0 ? current.statusFilePath : defaultStatusPath());

  /** @type {DiscordIpc | undefined} */
  let ipc;
  /** @type {WebhookPoster | undefined} */
  let webhook;
  let statusTimer;
  let lastStatusAt = 0;
  let lastNotifiedState;
  let disposed = false;

  /** Remember one diagnostic line, newest last. */
  function log(message) {
    const line = `${new Date().toISOString()} ${message}`;
    diagnostics.push(line);
    if (diagnostics.length > DIAGNOSTIC_LIMIT) diagnostics.shift();
  }

  /**
   * Report a transport state worth the user's attention exactly once per change.
   *
   * `unconfigured` and `invalid-client-id` are configuration problems: without a
   * word on stderr they look like the plugin silently doing nothing.
   * @param {{ state: string, detail: string }} change - the state transition.
   */
  function onTransportState(change) {
    log(`discord ${change.state}: ${change.detail}`);
    // The status file has to carry the reason a card is missing, so a transport
    // transition is worth a refresh of its own.
    requestRefresh(`discord/${change.state}`);
    if (change.state === lastNotifiedState) return;
    lastNotifiedState = change.state;
    if (change.state === 'invalid-client-id' || change.state === 'unconfigured') {
      process.stderr.write(`[discord-presence] ${change.detail}\n`);
    }
  }

  /** Start, stop or reconfigure the transport so it matches the current settings. */
  function reconcile() {
    if (disposed) return;
    if (!current.enabled) {
      if (ipc !== undefined) {
        ipc.stop();
        ipc = undefined;
      }
      return;
    }
    if (ipc !== undefined && ipc.clientId !== current.clientId) {
      ipc.stop();
      ipc = undefined;
    }
    if (ipc === undefined) {
      ipc = new DiscordIpc({
        clientId: current.clientId,
        minUpdateIntervalMs: current.minUpdateIntervalMs,
        // A non-standard Discord install can name its socket explicitly; tests use
        // the same escape hatch to point the transport at a mock server.
        candidates: socketOverride(),
        log,
      });
      ipc.on('state', onTransportState);
      ipc.start();
    } else {
      ipc.minUpdateIntervalMs = current.minUpdateIntervalMs;
      if (ipc.state === 'unconfigured' && current.clientId.length > 0) {
        // A client id was just saved; the transport parked itself as unconfigured.
        ipc.clientId = current.clientId;
        ipc.start();
      }
    }

    if (webhook === undefined || webhook.url !== current.webhookUrl) {
      webhook = new WebhookPoster({ url: current.webhookUrl, log });
    }
  }

  /** The workspace title for one cwd, when a workspace registry is mounted. */
  function titleForCwd(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
    const registry = ctx.get('workspaceRegistry');
    if (registry === undefined || typeof registry.list !== 'function') return undefined;
    try {
      const match = registry.list().find((workspace) => typeof workspace?.path === 'string' && samePath(workspace.path, cwd));
      return typeof match?.title === 'string' && match.title.length > 0 ? match.title : undefined;
    } catch {
      return undefined;
    }
  }

  /** The tracked state for a session, created on first sight. */
  function ensureState(session) {
    const id = typeof session?.id === 'string' ? session.id : 'unknown';
    live.set(id, session);
    let state = states.get(id);
    if (state === undefined) {
      state = createSessionState(session, Date.now());
      state.projectTitle = titleForCwd(state.cwd);
      // A restored session already has a durable route; read it instead of waiting
      // for the next `request/context` event to name the model.
      try {
        const route = session?.requestContext?.();
        if (route !== undefined && route !== null) {
          state.provider = route.provider ?? state.provider;
          state.model = route.model ?? state.model;
          state.contextWindow = route.contextWindow ?? state.contextWindow;
        }
      } catch {
        // A detached or partially constructed session may refuse; the event feed
        // will fill these in later.
      }
      states.set(id, state);
    }
    return state;
  }

  /** The effective token totals: the projection when it has folded the session, else the local fold. */
  function usageFor(state) {
    const session = live.get(state.id);
    const projected = session === undefined ? undefined : readProjectedUsage(ctx.get('sessionProjections'), session);
    return { usage: projected ?? state.usage, source: projected === undefined ? 'fold' : 'projection' };
  }

  /** Everything the renderer needs, read fresh so a tick picks up new numbers. */
  function snapshot() {
    const census = pickActiveSession(states.values());
    const active = census.active;
    let usageSource = 'fold';
    if (active !== undefined) {
      const effective = usageFor(active);
      active.effectiveUsage = effective.usage;
      usageSource = effective.source;
    }
    return {
      now: Date.now(),
      harnessStartedAt,
      active,
      live: census.live,
      subagents: census.subagents,
      sessions: census.sessions,
      webUrl,
      discord: ipc?.describe(),
      config: current,
      usageSource,
    };
  }

  /** The machine-readable document written beside the presence card. */
  function statusDocument(env, texts) {
    const strings = STRINGS[current.language] ?? STRINGS.en;
    const active = env.active;
    const usage = active?.effectiveUsage ?? active?.usage;
    return {
      plugin: 'dsh-discord-presence',
      version: '1.0.0',
      updatedAt: new Date(env.now).toISOString(),
      harness: {
        pid: process.pid,
        startedAt: new Date(harnessStartedAt).toISOString(),
        uptimeMs: env.now - harnessStartedAt,
        uptime: formatDuration(env.now - harnessStartedAt, strings),
        webUrl: webUrl.length > 0 ? webUrl : undefined,
      },
      discord: {
        enabled: current.enabled,
        clientId: current.clientId.length > 0 ? 'configured' : 'missing',
        state: env.discord?.state ?? 'disabled',
        detail: env.discord?.detail,
        ready: env.discord?.ready ?? false,
        socket: env.discord?.socket,
      },
      activity: {
        details: texts.details,
        state: texts.state,
        largeText: texts.largeText,
        startedAt: new Date(active === undefined ? harnessStartedAt : Math.max(active.createdAt, harnessStartedAt)).toISOString(),
      },
      sessions: {
        live: env.live,
        subagents: env.subagents,
        active: active?.id,
        all: env.sessions.map((state) => ({
          id: state.id,
          project: projectName(state),
          cwd: state.cwd,
          subagent: state.parentSession !== undefined || state.origin === 'subagent',
          busy: state.busy,
          turns: state.turns,
          steps: state.steps,
          tools: state.toolCalls,
          tokens: totalTokens(state.usage),
          lastEventAt: new Date(state.lastEventAt).toISOString(),
          lastEventType: state.lastEventType,
        })),
      },
      project: active === undefined
        ? undefined
        : { name: projectName(active), cwd: active.cwd, model: active.model, provider: active.provider, agentPreset: active.agentPreset },
      usage: usage === undefined
        ? undefined
        : {
            total: totalTokens(usage),
            input: usage.uncachedInput + usage.cacheRead + usage.cacheWrite,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            reasoning: usage.reasoning,
            source: env.usageSource,
          },
      counts: active === undefined
        ? undefined
        : { turns: active.turns, steps: active.steps, tools: active.toolCalls, retries: active.retries, interruptions: active.interruptions },
      turn: active === undefined
        ? undefined
        : {
            busy: active.busy,
            tokens: totalTokens(active.turnUsage),
            tokensTotal: formatTokens(totalTokens(active.turnUsage)),
            lastEndReason: active.lastTurnEndReason,
          },
      webhook: webhook?.describe(),
      diagnostics,
    };
  }

  /** Render and publish one snapshot: Discord card first, then the status file. */
  function refresh(reason) {
    if (disposed) return;
    reconcile();
    const env = snapshot();
    const { activity, texts } = buildActivity(env, current);

    if (current.enabled && ipc !== undefined) ipc.setActivity(activity);

    lastStatusAt = Date.now();
    if (current.statusFile) {
      const result = writeStatusFile(statusPath(), statusDocument(env, texts));
      if (!result.ok) log(`status file write failed: ${result.error}`);
    }
  }

  /** Debounced refresh: bursts of events collapse into one render. */
  function requestRefresh(reason) {
    if (disposed) return;
    if (statusTimer !== undefined) return;
    const wait = Math.max(0, STATUS_DEBOUNCE_MS - (Date.now() - lastStatusAt));
    if (wait === 0) {
      refresh(reason);
      return;
    }
    statusTimer = setTimeout(() => {
      statusTimer = undefined;
      refresh(reason);
    }, wait);
    statusTimer.unref?.();
  }

  /** Post one embed for a finished turn, if a webhook is configured. */
  function postTurn(env) {
    if (webhook === undefined || !current.webhookOnTurnEnd) return;
    const body = buildWebhookBody(env, current);
    void webhook.post(body).then((result) => {
      if (result.ok) log(`webhook: posted turn summary`);
      else if (result.skipped === undefined && result.error !== undefined) log(`webhook: ${result.error}`);
    });
  }

  /** Post a short "session started" embed, if the setting asks for one. */
  function postSessionStart(state) {
    if (webhook === undefined || !current.webhookOnSessionStart) return;
    const project = projectName(state) ?? 'DeepSeek Harness';
    const body = {
      username: 'DeepSeek Harness',
      embeds: [
        {
          title: `${project} — started`,
          description: state.cwd === undefined ? undefined : `\`${state.cwd}\``,
          color: 0x5865f2,
          timestamp: new Date().toISOString(),
          footer: { text: `session ${String(state.id).slice(-8)}` },
        },
      ],
    };
    void webhook.post(body).then((result) => {
      if (result.ok) log('webhook: posted session start');
    });
  }

  // --- host wiring ---------------------------------------------------------

  ctx.on('session/created', (session) => {
    const state = ensureState(session);
    log(`session created: ${state.id}${state.cwd === undefined ? '' : ` in ${state.cwd}`}`);
    postSessionStart(state);
    refresh('session/created');
  }, { global: true });

  ctx.on('session/event', (session, event) => {
    const state = ensureState(session);
    applyEvent(state, event);
    if (event?.type === 'turn/end') {
      // The webhook reports a finished turn, so it reads the numbers immediately
      // rather than through the debounce.
      const env = snapshot();
      refresh('turn/end');
      postTurn(env);
      return;
    }
    requestRefresh(event?.type ?? 'event');
  }, { global: true });

  ctx.on('session/disposed', (session) => {
    const id = typeof session?.id === 'string' ? session.id : undefined;
    if (id === undefined) return;
    states.delete(id);
    live.delete(id);
    log(`session disposed: ${id}`);
    refresh('session/disposed');
  }, { global: true });

  // A session that already existed when this plugin mounted (a settings reload, a
  // harness resume) is picked up here; its tokens come from the projection.
  const sessions = ctx.get('sessions');
  if (sessions !== undefined && typeof sessions.list === 'function') {
    try {
      for (const session of sessions.list()) ensureState(session);
    } catch (error) {
      log(`could not enumerate existing sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Periodic refresh: elapsed-dependent text, a reconnect attempt, a status heartbeat. */
  function tick() {
    refresh('tick');
  }

  // The timer service is fiber-disposed, but the plugin may be loaded where it is
  // not mounted at all, so both paths are registered inside one effect: whatever
  // handle came back is cleared when this fiber unloads.
  const timer = ctx.get('timer');
  const tickIntervalMs = Math.max(5000, current.tickIntervalMs);
  ctx.effect(() => {
    const handle = timer !== undefined && typeof timer.setInterval === 'function'
      ? timer.setInterval(tick, tickIntervalMs)
      : setInterval(tick, tickIntervalMs);
    handle?.unref?.();
    return () => {
      if (timer !== undefined && typeof timer.clearInterval === 'function') timer.clearInterval(handle);
      else clearInterval(handle);
    };
  }, 'discord-presence tick');

  ctx.effect(() => () => {
    disposed = true;
    clearTimeout(statusTimer);
    ipc?.stop();
    ipc = undefined;
    states.clear();
    live.clear();
  }, 'discord-presence lifecycle');

  refresh('startup');
  log(`started (client id ${current.clientId.length > 0 ? 'configured' : 'missing'})`);
}

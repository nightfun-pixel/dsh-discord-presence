/**
 * Host-free fold of the session event feed into the numbers the presence card shows.
 *
 * Everything here is pure: it takes plain objects in and gives plain objects out,
 * so the whole accounting layer is testable without a running harness and without
 * Discord. `index.js` owns the wiring; this file owns the arithmetic.
 *
 * The two token sources are deliberately different:
 *
 *   * {@link applyEvent} folds the provider usage carried by `assistant/message`
 *     events. That is the only place a per-call number exists, so it is what the
 *     per-turn figure (and the webhook) uses.
 *   * {@link readProjectedUsage} reads the `tokenUsage` projection when the
 *     composition registers one. That fold covers the complete durable log —
 *     including attempts that predate this plugin — so it wins for the session
 *     total whenever it is available.
 *
 * @module discord-presence/lib/session-tracker
 */

/** The four disjoint provider buckets this plugin counts. */
export function emptyUsage() {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
}

/**
 * Everything eaten by a request: the three disjoint prompt buckets plus output.
 *
 * Reasoning tokens are excluded on purpose — providers that report them separately
 * already include them in `outputTokens`, so adding them would double count.
 *
 * @param {object} usage - an {@link emptyUsage} shape.
 * @returns {number} billed tokens so far.
 */
export function totalTokens(usage) {
  return usage.uncachedInput + usage.cacheRead + usage.cacheWrite + usage.output;
}

/** Add one provider usage record into an accumulator, tolerating absent fields. */
export function addUsage(target, usage) {
  if (usage === null || typeof usage !== 'object') return target;
  target.uncachedInput += numberOr(usage.inputTokens);
  target.output += numberOr(usage.outputTokens);
  target.cacheRead += numberOr(usage.cacheReadTokens);
  target.cacheWrite += numberOr(usage.cacheWriteTokens);
  target.reasoning += numberOr(usage.reasoningTokens);
  return target;
}

/** A finite non-negative number, or 0. */
function numberOr(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Build the tracked state for one session.
 *
 * @param {{ id?: string, header?: object }} session - the live session.
 * @param {number} now - current epoch milliseconds.
 * @returns {object} a fresh state object.
 */
export function createSessionState(session, now) {
  const header = session?.header ?? {};
  return {
    id: session?.id ?? header.id ?? 'unknown',
    cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
    createdAt: numberOr(header.createdAt) || now,
    origin: header.origin,
    parentSession: header.parentSession,
    delegationDepth: numberOr(header.delegationDepth),
    agentPreset: header.agentPreset,

    provider: undefined,
    model: undefined,
    contextWindow: undefined,
    /** Title from the workspace registry, when one is mounted and knows this cwd. */
    projectTitle: undefined,

    turns: 0,
    steps: 0,
    toolCalls: 0,
    retries: 0,
    interruptions: 0,
    usage: emptyUsage(),
    /** Usage of the turn currently open (or the last one), for the webhook. */
    turnUsage: emptyUsage(),

    busy: false,
    lastEventAt: now,
    lastEventType: undefined,
    lastTurnEndReason: undefined,
    firstEventAt: now,
  };
}

/** True when this session is a delegated child rather than the user's own work. */
export function isSubagent(state) {
  return state.origin === 'subagent' || state.delegationDepth > 0 || state.parentSession !== undefined;
}

/**
 * Fold one committed session event into a state object.
 *
 * Unknown event types are ignored rather than rejected: the event vocabulary is
 * merge-extensible, and a presence card must not break when a plugin adds one.
 *
 * @param {object} state - state from {@link createSessionState}, mutated in place.
 * @param {{ type: string, time?: number, data?: object }} event - the appended event.
 * @returns {object} the same state, for chaining.
 */
export function applyEvent(state, event) {
  const data = event?.data ?? {};
  if (typeof event?.time === 'number' && Number.isFinite(event.time)) state.lastEventAt = event.time;
  state.lastEventType = event?.type;
  if (state.firstEventAt === undefined) state.firstEventAt = state.lastEventAt;

  switch (event?.type) {
    case 'turn/start':
      state.turns += 1;
      state.busy = true;
      state.turnUsage = emptyUsage();
      break;
    case 'turn/end':
      state.busy = false;
      state.lastTurnEndReason = data.reason?.kind;
      break;
    case 'step/end':
      state.steps += 1;
      break;
    case 'tool/call':
      state.toolCalls += 1;
      break;
    case 'llm/retry':
      state.retries += 1;
      break;
    case 'assistant/message':
      addUsage(state.usage, data.usage);
      addUsage(state.turnUsage, data.usage);
      if (data.interrupted === true) state.interruptions += 1;
      break;
    case 'request/context':
      if (typeof data.provider === 'string') state.provider = data.provider;
      if (typeof data.model === 'string') state.model = data.model;
      if (typeof data.contextWindow === 'number') state.contextWindow = data.contextWindow;
      break;
    default:
      break;
  }
  return state;
}

/**
 * Read the cumulative `tokenUsage` projection for one session.
 *
 * The projection state carries `totals`; a composition that serves the wire view
 * directly is accepted too, so both shapes work.
 *
 * @param {object|undefined} projections - `ctx.get('sessionProjections')`.
 * @param {object} session - the live session.
 * @returns {object|undefined} usage totals, or `undefined` when unavailable.
 */
export function readProjectedUsage(projections, session) {
  if (projections === undefined || typeof projections.stateOf !== 'function') return undefined;
  let state;
  try {
    state = projections.stateOf(session, 'tokenUsage');
  } catch {
    // A composition without the token meter mounted throws here; the fold above
    // already has a number, so this is not an error worth surfacing.
    return undefined;
  }
  const totals = state?.totals ?? state;
  if (totals === null || typeof totals !== 'object') return undefined;
  const usage = {
    uncachedInput: numberOr(totals.uncachedInputTokens),
    output: numberOr(totals.outputTokens),
    cacheRead: numberOr(totals.cacheReadTokens),
    cacheWrite: numberOr(totals.cacheWriteTokens),
    reasoning: 0,
  };
  // An all-zero projection means the meter has not folded this session yet; the
  // local fold is then the better answer rather than a suspicious zero.
  return totalTokens(usage) > 0 ? usage : undefined;
}

/**
 * Pick the session the presence card describes: the user's most recently active
 * one. Delegated children are excluded — a subagent working in a temp directory is
 * not "the project" — but they are still counted for the snapshot.
 *
 * @param {Iterable<object>} states - every tracked session state.
 * @returns {{ active: object|undefined, live: number, subagents: number, sessions: object[] }} the pick and the census.
 */
export function pickActiveSession(states) {
  const all = [...states];
  const own = all.filter((state) => !isSubagent(state));
  const pool = own.length > 0 ? own : all;
  let active;
  for (const state of pool) {
    if (active === undefined || state.lastEventAt > active.lastEventAt) active = state;
  }
  return {
    active,
    live: all.length,
    subagents: all.filter((state) => isSubagent(state)).length,
    sessions: all,
  };
}

/**
 * The project name for a session: the workspace title when the registry has one,
 * else the last path segment of the session's working directory.
 *
 * @param {object|undefined} state - the active session state.
 * @returns {string|undefined} a display name, or `undefined` when there is no cwd.
 */
export function projectName(state) {
  if (state === undefined) return undefined;
  if (typeof state.projectTitle === 'string' && state.projectTitle.length > 0) return state.projectTitle;
  if (typeof state.cwd !== 'string' || state.cwd.length === 0) return undefined;
  const parts = state.cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u);
  const last = parts[parts.length - 1];
  return last !== undefined && last.length > 0 ? last : state.cwd;
}

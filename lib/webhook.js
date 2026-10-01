/**
 * Optional Discord webhook poster.
 *
 * Rich Presence needs an application id from Discord's developer portal; a
 * channel webhook needs three clicks in Discord and nothing else. This module
 * covers the second path: it posts one embed per finished turn into a channel, so
 * the same numbers also land somewhere with history.
 *
 * The host exposes no outbound HTTP service (its `ctx.web` is GET-only), so this
 * uses the process-global `fetch`, which the deployment's proxy dispatcher already
 * covers.
 *
 * @module discord-presence/lib/webhook
 */

/** Discord rate-limits webhook posts; this floor keeps a fast turn loop polite. */
const DEFAULT_MIN_INTERVAL_MS = 5000;

/** A webhook post is a side channel, not a critical path: it may not hang forever. */
const REQUEST_TIMEOUT_MS = 10000;

/** A URL shaped like a Discord channel webhook, which is what the setting expects. */
const DISCORD_WEBHOOK = /^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/(v\d+\/)?webhooks\//u;

/**
 * A throttled poster with the counters the status file reports.
 */
export class WebhookPoster {
  /**
   * @param {object} options - poster options.
   * @param {string} options.url - the webhook URL; blank disables posting.
   * @param {number} [options.minIntervalMs] - floor between two posts.
   * @param {(message: string) => void} [options.log] - diagnostics sink.
   */
  constructor(options) {
    this.url = options.url ?? '';
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.log = options.log ?? (() => {});
    this.sent = 0;
    this.skipped = 0;
    this.lastError = undefined;
    this.lastSentAt = 0;
  }

  /** Whether a URL is configured and postable. */
  get configured() {
    return /^https?:\/\/\S+$/u.test(this.url);
  }

  /** Whether the configured URL looks like a Discord channel webhook rather than something else. */
  get looksLikeDiscord() {
    return DISCORD_WEBHOOK.test(this.url);
  }

  /**
   * Post one body, unless the throttle or the configuration says otherwise.
   * @param {object} body - a Discord webhook payload.
   * @returns {Promise<{ ok: boolean, skipped?: string, status?: number, error?: string }>} the outcome.
   */
  async post(body) {
    if (this.url.length === 0) return { ok: false, skipped: 'no webhook url configured' };
    if (!this.configured) {
      this.lastError = 'the configured webhook url is not an http(s) url';
      return { ok: false, error: this.lastError };
    }
    const elapsed = Date.now() - this.lastSentAt;
    if (elapsed < this.minIntervalMs) {
      this.skipped += 1;
      return { ok: false, skipped: `throttled for ${this.minIntervalMs - elapsed} ms` };
    }
    this.lastSentAt = Date.now();

    let response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log(`webhook post failed: ${this.lastError}`);
      return { ok: false, error: this.lastError };
    }
    if (!response.ok) {
      this.lastError = `HTTP ${response.status}`;
      this.log(`webhook rejected the post: ${this.lastError}`);
      return { ok: false, status: response.status, error: this.lastError };
    }
    this.sent += 1;
    this.lastError = undefined;
    return { ok: true, status: response.status };
  }

  /**
   * The counters reported in the status file.
   *
   * The URL itself is a credential, so only its host is ever reported.
   * @returns {object} a redacted summary.
   */
  describe() {
    let host;
    try {
      host = this.url.length > 0 ? new URL(this.url).host : undefined;
    } catch {
      host = 'unparsable';
    }
    return {
      configured: this.configured,
      looksLikeDiscord: this.looksLikeDiscord,
      host,
      sent: this.sent,
      skipped: this.skipped,
      lastError: this.lastError,
    };
  }
}

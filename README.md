# Discord Presence for DeepSeek Harness

[![English](https://img.shields.io/badge/README-English-2f81f7?style=for-the-badge)](README.md)
[![Русский](https://img.shields.io/badge/README-%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-8b949e?style=for-the-badge)](README.ru.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-3fb950?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3fb950?style=flat-square)](#requirements)
[![Tests](https://img.shields.io/badge/tests-48%20passing-3fb950?style=flat-square)](#tests)
[![Dependencies](https://img.shields.io/badge/dependencies-0-3fb950?style=flat-square)](#files)
[![Discord Rich Presence](https://img.shields.io/badge/Discord-Rich%20Presence-5865F2?style=flat-square)](#)

---

The plugin shows in Discord (Rich Presence) that the harness is up: which project it is working
on, how long it has been running, how many tokens it has eaten, how many turns and tool calls it
has made. Optionally it also writes a machine-readable `status.json` and posts an embed to a
Discord channel on every finished turn.

Zero dependencies: Node's standard library and the native Discord IPC only (named pipe on Windows,
unix socket on Linux/macOS). No `discord-rpc`, nothing to build.

```
┌──────────────────────────────────────────────┐
│ default-workspace                            │  ← details
│ waiting for a task                           │  ← state
│ default-workspace · 0 turns · 0 tools        │  ← largeText (hover)
│ · session 06b20207                           │
└──────────────────────────────────────────────┘
```

While it works:

```
┌──────────────────────────────────────────────┐
│ dsh-discord-presence                         │
│ deepseek/deepseek-v4.1-flash · 1.2M tokens   │
│ 4 turns · 17 tools · session 06b20207        │
└──────────────────────────────────────────────┘
```

The card is fully English and emoji-free; the project name is taken from the folder as is, in its
original language (`default-workspace`, `мой-проект`). The state is spelled out in words:
`running` — the harness is up, no sessions yet; `idle` — a session is sitting still; `working` — a
turn is in flight; `waiting for a task` — a session exists but has not done anything yet. Russian
strings are still available through `language: ru`, but English is the default.

---

## Requirements

* Node.js 20+ (the harness ships its own runtime, so normally you have it already).
* Discord **desktop** running on the same machine — Rich Presence does not work from the browser.
* A Discord Application ID — see the next section.

---

## Quick start

1. Open <https://discord.com/developers/applications> → **New Application** → call it whatever you
   like (for example `DeepSeek Harness`). It is just a container for the card; no bot is needed.
2. **General Information** → **Application ID** → Copy. It is an 18–19 digit number.
3. Put it into the plugin settings, either way:
   * **GUI**: Settings → Plugins → `discord-presence` → the **Client ID** field → save;
   * **file**: add an override row to `<DSH_HOME>\profiles\<profile>\cordis.patch.yml`:

     ```yaml
     - id: discord-presence
       name: 'dsh-discord-presence'
       config:
         clientId: '123456789012345678'
     ```

4. Restart the harness: the plugin row is read from `dsh.profile.bundles` at startup.
5. Discord **desktop** must be running — Rich Presence does not work from the browser.

Custom image (optional): in the application → **Rich Presence → Art Assets** upload a PNG with a
key, for example `harness`, then set `largeImage: harness`. Or just put an https link to an image
into `largeImage`. Empty means no image.

---

## What goes into the card

| Field | Where it comes from |
| --- | --- |
| project | the last segment of the active session's `cwd` (for subagents — the parent project) |
| `workspace` | the full `cwd` |
| model / provider | `session.requestContext()` and `request/context` events |
| tokens | the sum across all sessions: `uncachedInput + cacheRead + cacheWrite + output` |
| turns / steps / tools | a fold over `turn/*`, `step/*`, `tool/call` events |
| elapsed | the lifetime of the active session (for restored ones — not earlier than process start) |
| uptime | the lifetime of the harness process |
| sessions / subagents | how many sessions are live and how many of them are subagents |
| status | `running` / `idle` / `working` / `waiting for a task` |

The active session is picked like this: first the one that is currently running a turn, otherwise
the freshest root session (a subagent never becomes the headline of the card).

If the composition has the `tokenUsage` projection (`ctx.sessionProjections`), the counters come
from it — those are the provider's official numbers. Without the projection the plugin counts by
itself from `assistant/message` events. `status.json` shows which source was used:
`usage.source` = `projection` or `fold`.

---

## Settings

Every field is live (editable without a restart) and documented right in the settings card.

| Key | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Show the harness in Discord at all |
| `clientId` | `''` | Application ID; without it there is no card |
| `language` | `en` | Card language: `en` or `ru`. The project name is never translated |
| `showModel` | `true` | Show the model |
| `showTokens` | `true` | Show the tokens |
| `showTurns` | `true` | Show the number of turns |
| `showTools` | `true` | Show the number of tool calls |
| `detailsTemplate` | `''` | Full replacement of the first line (see placeholders) |
| `stateTemplate` | `''` | Full replacement of the second line |
| `largeImage` | `''` | An asset key in the application, or an https link |
| `largeText` | `''` | Tooltip of the image; empty — the built-in summary |
| `showButton` | `false` | An “Open DSH” button linking to the web UI (`DSH_WEB_URL`) |
| `webhookUrl` | `''` | A Discord channel webhook: one embed per finished turn |
| `webhookOnTurnEnd` | `true` | Post the webhook on `turn/end` |
| `webhookOnSessionStart` | `false` | Post the webhook on session start |
| `statusFile` | `true` | Write `status.json` |
| `statusFilePath` | `''` | A custom path; empty — `<DSH_HOME>/discord-presence/status.json` |
| `minUpdateIntervalMs` | `15000` | Minimum between card updates (Discord accepts ~5 per 20 s); `0` disables the throttle |
| `tickIntervalMs` | `30000` | How often to refresh the card and the file when nothing happens (minimum 5000) |

### Template placeholders

`{project}` `{workspace}` `{model}` `{provider}` `{tokens}` `{tokensIn}`
`{tokensOut}` `{turns}` `{steps}` `{tools}` `{session}` `{agent}` `{status}` `{elapsed}`
`{uptime}` `{sessions}` `{subagents}` `{discord}`

`{session}` is the last 8 characters of the id, `{tokens}` is abbreviated (`1.2M`, `17k`). Empty
pieces are dropped together with their `·` separators, so a template never leaves dangling dots.
Discord cuts a line at 128 characters — the plugin truncates on its own.

---

## Status file

By default: `<DSH_HOME>\discord-presence\status.json` (on Windows that is something like
`C:\Users\<you>\.dsh\discord-presence\status.json`). It is written atomically (tmp + rename), at
most once per second, and a write failure never takes the plugin down.

```jsonc
{
  "plugin": "dsh-discord-presence",
  "version": "1.0.0",
  "updatedAt": "2026-09-30T17:42:49.377Z",
  "harness": { "pid": 15508, "uptimeMs": 33981, "uptime": "33s" },
  "discord": { "enabled": true, "clientId": "missing", "state": "unconfigured", "ready": false },
  "activity": { "details": "default-workspace", "state": "waiting for a task" },
  "sessions": { "live": 1, "subagents": 0, "active": "session-…", "all": [ /* per session */ ] },
  "project": { "name": "default-workspace", "cwd": "C:\\…", "agentPreset": "standard" },
  "usage": { "total": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "source": "fold" },
  "counts": { "turns": 0, "steps": 0, "tools": 0, "retries": 0, "interruptions": 0 },
  "webhook": { "configured": false, "sent": 0, "skipped": 0 },
  "diagnostics": [ /* the last 40 lines of the plugin log */ ]
}
```

The file is handy for OBS, a Stream Deck, your own scripts or another plugin — for example to draw
a “tokens eaten during this stream” overlay. The webhook URL never lands in the file: only its host
is kept, the path is redacted.

---

## Files

| File | What is inside |
| --- | --- |
| `index.js` | the cordis plugin: settings schema, session event subscriptions, card assembly, status file, webhook |
| `lib/discord-ipc.js` | transport: pipe discovery `discord-ipc-0..9`, `opcode\|length\|json` framing, handshake, reconnect, throttle |
| `lib/session-tracker.js` | a pure fold of events into counters: tokens, turns, tools, active-session selection |
| `lib/presence.js` | card rendering: lines, templates, plural forms, duration and token formatting |
| `lib/status-file.js` | atomic `status.json` writes |
| `lib/webhook.js` | throttled embed posting |
| `cordis.patch.yml` | the row the bundle inserts into the profile composition |
| `test/` | tests (see below) |

---

## Tests

```powershell
cd <path to the plugin>
node test/presence.test.mjs   # 23 — rendering, plurals, templates, toggles
node test/ipc.test.mjs        # 12 — framing, handshake, CLOSE, reconnect
node test/plugin.test.mjs     # 13 — the whole plugin: mock Discord + a local HTTP receiver
```

All three suites are self-contained: they bring up their own named pipe and their own HTTP server,
never reach outside, and clean up after themselves (the process exits on its own, no
`--test-force-exit`).

There is also a live transport check against a real Discord:

```powershell
node test/probe-live-discord.mjs <ApplicationID>
```

The script connects to the real pipe, completes the handshake, sets a card and then clears it.
With a fake id Discord answers `CLOSE 4000 Invalid Client ID` — which is a useful result too.

---

## Install and remove

From GitHub (the repository is public):

```powershell
dsh plugin --profile web add github:nightfun-pixel/dsh-discord-presence
```

Local development — a link dependency on a clone of the repository:

```powershell
dsh plugin --profile web add "link:D:/path/to/dsh-discord-presence"
```

Here `dsh` is `node '<DSH_HOME>\..\app\node_modules\@deepseek-ai\dsh\lib\bin.js'`; the `plugin`
subcommand simply proxies pnpm into the profile directory. The command itself adds the package to
`dependencies` and to `dsh.profile.bundles` of the profile
`<DSH_HOME>\profiles\<profile>\package.json` and creates a junction in `node_modules\`. Edits in a
link dependency are picked up without reinstalling — only a harness restart is needed.

Remove:

```powershell
dsh plugin --profile web remove dsh-discord-presence
```

---

## Troubleshooting

| Symptom | Cause and what to do |
| --- | --- |
| `discord.state: "unconfigured"` | `clientId` is not set. Fill it in and restart the harness. |
| `discord.state: "invalid-client-id"` | Discord answered `CLOSE 4000` — a typo in the Application ID. The plugin deliberately does not reconnect in a loop; fix the id (the edit is picked up on the fly). |
| `discord.state: "offline"` | Discord is not running or the pipe was not found. Check `\\.\pipe\discord-ipc-0` (Windows). The plugin reconnects by itself once the client appears. |
| The card is there but empty | The session has not run a turn yet: `waiting for a task` is shown. |
| No card, but the log says `connected` | Discord only shows activity for the desktop client, and only once the application has at least one activity; wait out the 15 s throttle. |
| The harness does not see the plugin | The row never made it into `dsh.profile.bundles`, or the harness was not restarted. Check `--dump-config`: |

```powershell
dsh --profile web --dump-config | Select-String -Pattern 'discord-presence' -Context 0,10
```

The plugin log lives in `status.json` (`diagnostics`) and on the harness stderr as
`[discord-presence] …` lines.

---

## Limitations

* Rich Presence only works with a running **desktop** Discord client.
* Discord accepts roughly 5 updates per 20 seconds — hence the 15 s default throttle; the counters
  do not suffer from it, they are still computed on every event.
* The plugin does not subscribe to unknown events: an unrecognized event type is ignored instead of
  breaking the handler (see `lastEventType` in `diagnostics`).
* No network requests apart from the optional webhook. The Application ID is a public identifier,
  not a secret; the plugin never reads tokens or keys.

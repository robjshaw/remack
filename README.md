# slackline

A zero-dependency, Remix-shaped Slack framework. The app is a web-standard
`(Request) => Response` fetch handler; every Slack surface is one file in a
`routes/` directory; the HTTP response IS the ack.

- **Zero runtime dependencies, no database required.** Signature
  verification via WebCrypto, the Web API via `fetch`, OAuth included —
  state lives in a pluggable KV storage that defaults to memory. Node ≥ 22
  (Bun/Deno/Workers-portable core).
- **Route modules.** Colocate `loader` (data), `default` (handler), `render`
  (Block Kit), and `ErrorBoundary` per surface — no build step, routes are
  discovered with an fs scan at startup.
- **Structurally safe acks.** Events are acked before handlers run; unknown
  interactions are always acked; handler errors run a boundary chain and
  still return 200.

**Full API contract: [AGENTS.md](./AGENTS.md)** — written to be read by
humans and LLMs alike.

## Quickstart

```
npm link                        # once, from this repo (registers the `slackline` command)
slackline create my-bot         # scaffold: app.js + working routes for every pattern
cd my-bot && npm install
slackline manifest --url https://YOUR-TUNNEL   # paste into api.slack.com → "Create from manifest"
slackline profiles:add my-bot   # save credentials once (twilio-cli style; or cp .env.example .env)
slackline dev                   # run with watch; env comes from .env + active profile
```

Or by hand — the whole app is:

```js
// app.js
import { createApp, serve } from '@tbp/slackline';

const app = createApp({ routes: new URL('./routes/', import.meta.url) });
await app.ready;
await serve({ fetch: app.fetch, port: 3000, onIdle: app.idle });
```

```js
// routes/command.ping.js
export default async () => 'pong';
```

```js
// routes/event.app_home_opened.js — loader + render, framework publishes
export const loader = async ({ client, userId }) => ({ user: await client.users.info({ user: userId }) });
export const render = ({ data }) => [
  { type: 'section', text: { type: 'mrkdwn', text: `Hi ${data.user.user.real_name}` } },
];
```

Point every Slack Request URL (commands, interactivity, events, options) at
`https://<host>/events`. Runnable demo: `examples/route-bot/`.

## Route filename convention

| File | Handles |
|---|---|
| `command.report.js` | slash command `/report` |
| `action.open_settings.js` | block action `action_id: open_settings` |
| `action.row_$.js` | action_ids matching `/^row_.*$/` (`$` = wildcard) |
| `view.settings.js` | modal submit `callback_id: settings` |
| `view_closed.settings.js` | modal close |
| `shortcut.new_task.js` | global/message shortcut |
| `options.project_picker.js` | external-select suggestions |
| `event.app_home_opened.js` | Events API event type |

## CLI

| Command | Does |
|---|---|
| `slackline create <dir>` | Scaffold a bot (`--mode token\|oauth`, `--target apps-script`) |
| `slackline build:apps-script` | Bundle slackline into one script for Google Apps Script |
| `slackline dev [entry]` | Run with `--watch`; env layered process → `.env` → active profile |
| `slackline routes` | Show the route table with each module's exports |
| `slackline manifest` | Slack App Manifest derived from `routes/` (`--url`, `--oauth`, `--out`) |
| `slackline profiles[:add\|:use\|:remove]` | Credential profiles in `~/.config/slackline/` |

The manifest is the onboarding shortcut: your route files already declare the
commands, events, and interactivity — `manifest` turns them into the exact
JSON Slack's "Create from manifest" screen wants, right URLs included.

## Google Apps Script: no server at all

```
slackline create my-bot --target apps-script
```

gives you `Code.js` + `slackline.js` to paste into script.google.com (or
push with clasp). Deploy as a web app, point Slack at it, done: no hosting,
free on any Google account. (No Node? Copy `dist/apps-script/slackline.js`
from this repo instead of running the CLI.)

```js
function routes() {
  return [Slackline.route('command', '/ping', { default: () => 'pong' })];
}
let app_;
function app() { return app_ || (app_ = Slackline.createAppsScriptApp({ routes: routes() })); }
function doPost(e) { return app().doPost(e); }
```

The trade-offs are real, so the scaffold's README spells them out:
- **Weaker request auth.** Apps Script can't read headers, so the request
  signature can't be checked. Requests are authenticated with Slack's
  verification token plus a secret `?key=` on the URL instead.
- **Synchronous handlers.** No async/await, and no `defer()`.
- **Everything runs inside Slack's 3-second window**, cold start included.

Good for internal tools and prototypes. For anything sensitive, use the
Node or serverless targets.

## Env vars

| Variable | Purpose |
|---|---|
| `SLACK_SIGNING_SECRET` | Request verification (required) |
| `SLACK_BOT_TOKEN` | Single-token mode (the default mode) |
| `SLACK_ALERTS_CHANNEL` | `ext/ops-alert` destination |
| `SLACKLINE_DEBUG` | Debug output from the fallback logger |

Env is only a default for explicit options — pass `createApp({ env })` to
read from somewhere other than `process.env` (e.g. Workers bindings). An
explicit `oauth` config always means OAuth mode, even if `SLACK_BOT_TOKEN`
happens to be set. slackline never reads `DATABASE_URL` and never opens
connections.

## Hosting

The app is `app.fetch(request, ...platformArgs)`. Long-running Node:
`serve()`. Serverless: post-ack work (events, `defer`) is handed to the
platform's `waitUntil` so it isn't frozen after the response —

```js
export default { fetch: (req, env, ctx) => app.fetch(req, env, ctx) };  // Workers: ctx.waitUntil picked up
createApp({ waitUntil, ... });                                          // Vercel: from @vercel/functions
```

## Logging

Every request gets a `requestId` and `args.log`, a logger bound to
`{requestId, kind, id, teamId, userId}`, and ends with one line:
`Slack request handled {status, outcome, ackMs}` — or a `Slow Slack ack`
warning past 2s, before Slack's 3s cutoff bites.

## Several apps, one process

```js
const sales = createApp({ namespace: 'sales', storage, oauth: salesOAuth, signingSecret: SALES_SECRET });
const support = createApp({ namespace: 'support', storage, oauth: supportOAuth, signingSecret: SUPPORT_SECRET });
```

`namespace` scopes storage (`sales:installations`) and tags logs, so apps
can share one Postgres table without colliding.

## Storage — portable by default

Everything that persists (OAuth installations, feature grants, engagement
events) speaks one four-method KV contract. Pick the backend that fits, or
implement the contract over anything:

```js
import { createApp, fileStorage } from '@tbp/slackline';

createApp({ ... });                                        // memory (default): zero setup, dev-perfect
createApp({ storage: fileStorage('./data/bot.json') });    // one JSON file: survives restarts
```

```js
import { postgresStorage } from '@tbp/slackline/ext/postgres-storage.js';
createApp({ storage: postgresStorage({ pool }) });         // shared DB: multi-instance (1 table, 1 migration)
```

OAuth mode needs no store configuration — installations persist in whatever
`storage` you chose (with a startup warning if that's the in-memory
default).

## Optional modules (`@tbp/slackline/ext/*`)

All storage-based (pass `app.storage`) except the pure ones: `ops-alert`
(never-throws job alerts), `file-delivery` (DM upload with `missing_scope`
inline fallback), `plan-block` (progress UI), `feature-access` (invite-only
gating), `engagement-tracker` (analytics), `postgres-storage` (the Postgres
storage adapter; SQL in `migrations/`).

## Development

```
npm test          # node:test — no network, no DB, no Slack
npm run example   # examples/route-bot (needs SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET)
```

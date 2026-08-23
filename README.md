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

## Env vars

| Variable | Purpose |
|---|---|
| `SLACK_SIGNING_SECRET` | Request verification (required) |
| `SLACK_BOT_TOKEN` | Single-token mode (the default mode) |
| `SLACK_ALERTS_CHANNEL` | `ext/ops-alert` destination |
| `SLACKLINE_DEBUG` | Debug output from the fallback logger |

Env is only a default for explicit options. slackline never reads
`DATABASE_URL` and never opens connections.

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

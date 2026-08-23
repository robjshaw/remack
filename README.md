# slackline

A zero-dependency, Remix-shaped Slack framework. The app is a web-standard
`(Request) => Response` fetch handler; every Slack surface is one file in a
`routes/` directory; the HTTP response IS the ack.

- **Zero runtime dependencies.** Signature verification via WebCrypto, the
  Web API via `fetch`, OAuth included. Node ≥ 22 (Bun/Deno/Workers-portable
  core).
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
`DATABASE_URL` — Postgres-backed extras take an injected pool.

## Optional modules (`@tbp/slackline/ext/*`)

`installation-store` (Postgres OAuth store), `ops-alert` (never-throws job
alerts), `file-delivery` (DM upload with `missing_scope` inline fallback),
`plan-block` (progress UI), `feature-access` (invite-only gating),
`engagement-tracker` (analytics). SQL in `migrations/`.

## Development

```
npm test          # node:test — no network, no DB, no Slack
npm run example   # examples/route-bot (needs SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET)
```

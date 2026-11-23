# remack

A zero-dependency Slack bot framework for Node 22 and up. The name comes from Remix + ack (pronounced "ree-mack"): each Slack command, button, modal, event, or workflow step lives in its own file under `routes/`, and the response your handler returns is the acknowledgement to Slack.

remack has no runtime dependencies and needs no database to start. Request verification uses WebCrypto, Slack Web API calls use `fetch`, OAuth is built in, and state sits in a four-method key-value store that defaults to memory. The core app is a standard `(Request) => Response` fetch handler, so it runs on Node, Cloud Run, Cloudflare Workers, Netlify, or Vercel.

See [AGENTS.md](./AGENTS.md) for the full API reference.

## Quickstart

Link the CLI once from this repo, scaffold a bot, and run it:

```bash
npm link
remack create my-bot
cd my-bot && npm install
```

From there, you have two ways to get a public HTTPS URL for Slack:

1. Local dev with a tunnel (ngrok, cloudflared, etc.):

```bash
remack manifest --url https://YOUR-TUNNEL   # paste into api.slack.com -> "Create from manifest"
remack profiles:add my-bot                  # save credentials once, or copy .env.example to .env
remack dev                                  # runs with --watch using .env + active profile
```

2. Deploy straight to Google Cloud Run (no tunnel needed):

```bash
remack deploy:gcp --region us-central1 --sync-env --push-manifest --app-id YOUR_SLACK_APP_ID
```

If you prefer to wire an app by hand instead of using `remack create`, the whole setup is three small files:

```js
// app.js
import { createApp, serve } from 'remack';

const app = createApp({ routes: new URL('./routes/', import.meta.url) });
await app.ready;
await serve({ fetch: app.fetch, port: process.env.PORT || 3000, onIdle: app.idle });
```

```js
// routes/command.ping.js
export default async () => 'pong';
```

```js
// routes/event.app_home_opened.js
export const loader = async ({ client, userId }) => ({
  user: await client.users.info({ user: userId }),
});

export const render = ({ data }) => [
  { type: 'section', text: { type: 'mrkdwn', text: `Hi ${data.user.user.real_name}` } },
];
```

Point all Slack Request URLs (slash commands, interactivity, events, and options) at `https://<your-host>/events`. For a full working demo, see `examples/route-bot/`.

## How routes work

Every route file in `routes/` follows the `{kind}.{id}.js` naming pattern. remack scans the directory at startup with no build step.

| File | Handles |
|---|---|
| `command.report.js` | slash command `/report` |
| `action.open_settings.js` | block action `action_id: open_settings` |
| `action.row_$.js` | action_ids matching `/^row_.*$/` (`$` is a wildcard) |
| `view.settings.js` | modal submission `callback_id: settings` |
| `view_closed.settings.js` | modal close |
| `shortcut.new_task.js` | global or message shortcut |
| `options.project_picker.js` | external-select suggestions |
| `event.app_home_opened.js` | Events API event type |
| `function.prep_step.js` | Slack Workflow Builder custom step (`function_executed`) |

Each file can export `default` (the handler), `loader` (data fetched into `args.data`), `render` (Block Kit for declarative surfaces like the App Home tab), and `ErrorBoundary` (per-route error handling).

Slack expects an HTTP 200 within 3 seconds. remack handles that by default: events and custom workflow steps ack 200 before your code runs, unmatched interactions still ack 200 so users never see a timeout warning, and uncaught errors run through `ErrorBoundary`, then app `onError`, then a safe fallback while still returning 200. For slow work inside commands or actions, wrap it in `args.defer(async () => { ... })`.

## Workflows

remack supports both Slack's native Workflow Builder custom steps and in-app multi-step workflows.

### Slack Workflow Builder custom steps

Drop a `function.<callback_id>.js` file in `routes/`. Export `manifest` with `defineFunctionManifest` so `remack manifest --inspect` includes the step's inputs and outputs:

```js
// routes/function.greet_user.js
import { defineFunctionManifest, Schema } from 'remack';

export const manifest = defineFunctionManifest({
  title: 'Greet User',
  inputs: {
    user_id: { type: Schema.user_id, title: 'User', required: true },
  },
  outputs: {
    greeting: { type: Schema.string, title: 'Greeting', required: true },
  },
});

export default async ({ inputs }) => ({
  greeting: `Hello <@${inputs.user_id}>!`,
});
```

Returning an object automatically calls `functions.completeSuccess`. Throwing an error calls `functions.completeError`. Returning `undefined` leaves the step open so you can finish it later from a button click or modal submission using `client.functions.completeSuccess`.

### In-app multi-step workflows

When you need a multi-step flow with approvals or modals inside your bot, use `createWorkflow`. It stores run state in `storage`, pauses on `pause()`, and generates the trigger, action, and modal routes for you:

```js
import { createApp, createWorkflow, pause, fileStorage } from 'remack';

const storage = fileStorage('./data/bot.json');

const deployFlow = createWorkflow({
  id: 'deploy',
  title: 'Deploy Service',
  storage,
  trigger: { kind: 'command', id: '/deploy' },
  steps: [
    {
      id: 'approve',
      title: 'Manager approval',
      run: async ({ client, args, actionId }) => {
        await client.chat.postMessage({
          channel: args.channelId,
          text: 'Approve this deploy?',
          blocks: [
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Approve' },
                  action_id: actionId(),
                  value: 'approved',
                },
              ],
            },
          ],
        });
        return pause();
      },
      onResume: ({ resumeInput }) => ({ approvedBy: resumeInput.userId }),
    },
    {
      id: 'ship',
      title: 'Ship release',
      run: async ({ state }) => ({ shippedBy: state.approvedBy }),
    },
  ],
});

const app = createApp({ storage, routes: [...deployFlow.routes()] });
```

Use `deployFlow.renderProgress(run)` to render step status as Block Kit, and `extractViewValues(payload)` to flatten Slack's nested `view.state.values` on modal submissions.

## CLI

| Command | Does |
|---|---|
| `remack create <dir>` | Scaffold a bot (`--mode token\|oauth`, `--target apps-script`) |
| `remack dev [entry]` | Run with `--watch`; env comes from process, then `.env`, then active profile |
| `remack routes` | Print the route table and each module's exports |
| `remack manifest` | Generate Slack App Manifest v2 JSON from `routes/` (`--url`, `--oauth`, `--inspect`, `--out`) |
| `remack manifest:validate` | Validate your manifest against Slack's `apps.manifest.validate` API |
| `remack manifest:push` | Push manifest updates to an existing Slack app (`--app-id A0...`) |
| `remack manifest:create` | Create a new Slack app from your manifest and print its credentials |
| `remack deploy:gcp` | Deploy to Google Cloud Run and optionally run `manifest:push` |
| `remack build:apps-script` | Bundle remack into one script for Google Apps Script |
| `remack profiles[:add\|:use\|:remove]` | Manage credential profiles in `~/.config/remack/` |

Because your route files already declare your commands, events, shortcuts, and workflow steps, `remack manifest` generates the Slack App Manifest JSON for you. With an App Configuration Token (`SLACK_APP_CONFIG_TOKEN` or `--config-token`), `manifest:create`, `manifest:validate`, and `manifest:push` sync changes straight to Slack without copying and pasting JSON in the browser.

## Deploying to Google Cloud Run

Cloud Run gives you a stable HTTPS URL with no tunnel and no Dockerfile. Cloud Run's Node.js buildpack runs `npm start`, and bots scaffolded with `remack create` already listen on `process.env.PORT`.

```bash
# Preview the gcloud command first
remack deploy:gcp --region us-central1 --project my-gcp-project --dry-run

# Deploy and sync SLACK_* vars from .env or your active profile
remack deploy:gcp --region us-central1 --project my-gcp-project --sync-env

# Deploy with Secret Manager and push the new Cloud Run URL into Slack
remack deploy:gcp \
  --region us-central1 \
  --set-secrets SLACK_SIGNING_SECRET=slack-secret:latest,SLACK_BOT_TOKEN=slack-token:latest \
  --push-manifest --app-id YOUR_SLACK_APP_ID
```

By default, `deploy:gcp` passes `--no-cpu-throttling` so Cloud Run does not freeze `defer()`, `event.*`, or `function.*` work after the HTTP 200 response goes out. Pass `--cpu-throttling` if your bot does no post-ack work.

## Google Apps Script (no server)

If you want to run an internal bot with no server hosting at all, scaffold an Apps Script project:

```bash
remack create my-bot --target apps-script
```

This creates `Code.js` and `remack.js` to paste into script.google.com (or push with `clasp`). Deploy it as a web app, point Slack at the web app URL, and you are live on any Google account. Without Node installed, you can copy `dist/apps-script/remack.js` directly from this repo.

```js
function routes() {
  return [Remack.route('command', '/ping', { default: () => 'pong' })];
}
let app_;
function app() { return app_ || (app_ = Remack.createAppsScriptApp({ routes: routes() })); }
function doPost(e) { return app().doPost(e); }
```

Apps Script comes with three limits to keep in mind:
- Apps Script cannot read HTTP request headers, so HMAC signature checks are not possible. Requests are checked with Slack's verification token plus a secret `?key=` query parameter on the URL instead.
- Handlers must be synchronous (no `async`/`await` and no `defer()`).
- All work runs inside Slack's 3-second ack window, cold start included.

It works well for internal utilities and quick prototypes. For production or sensitive data, use Node, Cloud Run, or another serverless target.

## Storage

Everything that persists (OAuth installations, workflow runs, feature grants, engagement counts) uses the same four-method KV interface (`get`, `put`, `delete`, `list`). Start in memory and swap the backend later without changing your routes:

```js
import { createApp, fileStorage } from 'remack';
import { postgresStorage } from 'remack/ext/postgres-storage.js';

createApp({ ... });                                     // memory (default)
createApp({ storage: fileStorage('./data/bot.json') }); // single JSON file
createApp({ storage: postgresStorage({ pool }) });      // Postgres (1 table, see migrations/)
```

In OAuth mode, installations persist in whatever `storage` you pass (with a startup warning if you leave it on the in-memory default).

## Hosting and runtimes

`app.fetch(request, ...platformArgs)` works anywhere web `Request` and `Response` exist. On long-running Node servers, use `serve({ fetch: app.fetch, onIdle: app.idle })`. On serverless runtimes, post-ack work (`defer()` and events) is passed to `waitUntil` automatically when present:

```js
// Cloudflare Workers (ctx.waitUntil is detected automatically)
export default { fetch: (req, env, ctx) => app.fetch(req, env, ctx) };

// Vercel
import { waitUntil } from '@vercel/functions';
const app = createApp({ waitUntil, ... });
```

## Environment variables

| Variable | Purpose |
|---|---|
| `SLACK_SIGNING_SECRET` | Request signature verification (required) |
| `SLACK_BOT_TOKEN` | Single-workspace bot token (default mode) |
| `SLACK_APP_CONFIG_TOKEN` | App Configuration Token for `manifest:validate\|push\|create` |
| `SLACK_APP_ID` | Default Slack App ID for `manifest:push` and `deploy:gcp` |
| `SLACK_ALERTS_CHANNEL` | Channel for `ext/ops-alert` |
| `REMACK_DEBUG` | Enable debug logs on the fallback console logger |

Environment variables are only defaults for explicit options. Pass `createApp({ env })` to read from another source (such as Cloudflare Workers bindings). Passing an explicit `oauth` object always selects OAuth mode, even if `SLACK_BOT_TOKEN` is set in the environment. remack never reads `DATABASE_URL` or opens database connections on its own.

## Logging and multi-app processes

Every request gets a `requestId` and a bound logger at `args.log` carrying `{requestId, kind, id, teamId, userId}`. Each request finishes with one summary line (`Slack request handled {status, outcome, ackMs}`), or a `Slow Slack ack` warning if it takes longer than 2 seconds.

To host multiple Slack apps in one process, give each app its own `namespace`:

```js
const sales = createApp({ namespace: 'sales', storage, oauth: salesOAuth, signingSecret: SALES_SECRET });
const support = createApp({ namespace: 'support', storage, oauth: supportOAuth, signingSecret: SUPPORT_SECRET });
```

`namespace` prefixes storage keys (`sales:installations`) and adds `{app: 'sales'}` to every log line so apps can share one database without colliding.

## Optional modules (`remack/ext/*`)

- `ops-alert`: post error alerts to a Slack channel without ever throwing
- `file-delivery`: upload files to a DM with automatic inline text fallback on `missing_scope`
- `plan-block`: Block Kit step-progress checklists
- `feature-access`: invite-only feature gating backed by `app.storage`
- `engagement-tracker`: lightweight usage tracking backed by `app.storage`
- `postgres-storage`: Postgres KV adapter (SQL in `migrations/001_remack_kv.sql`)

## Development

```bash
npm test          # node:test (no network, no DB, no Slack credentials needed)
npm run example   # runs examples/route-bot (needs SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET)
```

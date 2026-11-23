# remack — full contract

Zero-dependency Slack framework. ESM, Node ≥ 22, no build step. This file is
the complete reference; the README is the tour.

## Mental model

1. `createApp(options)` returns `{ fetch, client, ready, idle }`. `fetch` is
   a web-standard `(Request) => Promise<Response>` — THE app. Mount it
   anywhere bytes arrive raw.
2. Slack POSTs three wire shapes to one endpoint (`paths.events`,
   default `/events`); remack verifies, parses, and normalizes them, then
   dispatches to a route module.
3. **The HTTP response is the ack.** A route's return value becomes the
   response body. Slack gives you 3 seconds — do slow work in `defer()`.
4. Errors never become 5xx. They run route `ErrorBoundary` → app `onError` →
   built-in default, and Slack still gets a 200.

## createApp(options)

```js
createApp({
  signingSecret,      // required; default env SLACK_SIGNING_SECRET
  env,                // where env defaults come from; default process.env (or {})
  botToken,           // single-token mode; default env SLACK_BOT_TOKEN — but
                      //   ONLY when no `oauth` is passed
  oauth: {            // multi-workspace mode (used when botToken is absent)
    clientId, clientSecret, stateSecret,   // all required
    scopes,           // required; MUST match your app manifest
    userScopes,       // optional
    store,            // OPTIONAL { get, set, delete } override; installations
                      //   persist in `storage` by default
    redirectUri,      // optional explicit redirect_uri
  },
  storage,            // namespaced KV (see Storage below); default memoryStorage()
  namespace,          // [A-Za-z0-9_.-]+: prefixes this app's storage namespaces
                      //   ('sales:installations') and adds {app} to every log line
  waitUntil,          // (promise) => void for post-ack work on serverless
                      //   (Vercel); a waitUntil on fetch's extra args wins
  routes,             // dir (string|URL) for fs discovery, RouteDef[], or mixed array
  context,            // object injected into every args (your services/pools)
  onError,            // (error, args) => ackValue|void — app error boundary
  opsAlert,           // (title, {error, context}) => — e.g. ext/ops-alert sendOpsAlert
  logger,             // pino-like; console fallback otherwise
  paths,              // { events:'/events', install:'/install', redirect:'/oauth_redirect' }
  ignoreEventRetries, // default true: drop x-slack-retry-num duplicates
  genericMessage,     // default 'Something went wrong. Please try again.'
}) => { fetch, client /* single-token client or null */, storage, ready /* routes loaded */, idle() }
```

Mode: `botToken` present → single-token. Else `oauth` → per-request token
lookup (installations namespace of `storage`, or your `oauth.store`
override); unknown workspace acks 200 (never 500);
`app_uninstalled`/`tokens_revoked` events auto-delete the installation.
OAuth endpoints: GET `paths.install` (302 to Slack, HMAC state + cookie
CSRF, 10-min expiry), GET `paths.redirect` (code exchange via form-encoded
`oauth.v2.access`, then the installation is stored). OAuth mode on default
in-memory storage logs a warning: installations vanish on restart.

Several apps in one process: give each its own `namespace` (and explicit
secrets or its own `env`), mount each `app.fetch` at its own path. Apps
sharing one `storage` without a namespace share its `installations`.

## Storage (the one persistence primitive)

```js
{
  get(ns, key)                     // → value | null
  put(ns, key, value)              // value: JSON-serializable
  delete(ns, key)
  list(ns, {prefix?, limit?} = {}) // → [{key, value}] sorted by key
}
```

Implementations: `memoryStorage()` (core, default), `fileStorage(path)`
(core; one JSON file, atomic writes, single-instance),
`postgresStorage({pool, table?})` (`ext/postgres-storage.js`; one JSONB
table, `migrations/001_remack_kv.sql`, pool injected — pg never
imported). Implement the same four methods to back it with anything else
(Redis, DynamoDB, Workers KV). Namespaces in use: `installations`,
`feature-access`, `feature-access-log`, `engagement`, `analytics` — each
becomes `{namespace}:{ns}` under `createApp({namespace})`, and `app.storage`
is that scoped view (pass it to ext modules). `namespacedStorage(storage,
prefix)` does the same scoping by hand.

## Route modules

Exports (all may be async):

| Export | Signature | Meaning |
|---|---|---|
| `default` | `(args) => ackValue` | Handle the payload; return the ack |
| `loader` | `(args) => data` | Optional pre-fetch; result at `args.data` |
| `render` | `(args) => blocks \| view` | Declarative surfaces (home tab); on non-event kinds acts as `default` |
| `ErrorBoundary` | `({...args, error}) => ackValue` | Per-route error rendering |

A module must export `default` or `render`.

### args (one object, every export)

```js
{
  requestId,     // incoming x-request-id, else a random UUID
  log,           // logger bound to {requestId, kind, id, teamId, userId[, app]}
  kind,          // 'command'|'action'|'view'|'view_closed'|'shortcut'|'options'|'event'|'function'
  id,            // '/report' | action_id | callback_id | event type | function callback_id
  payload,       // FULL parsed body — the raw Slack payload, nothing hidden
  teamId, userId, channelId, triggerId, responseUrl,   // null when absent
  client,        // token-bound API client for this workspace
  context,       // what you passed to createApp
  data,          // loader result
  respond(msg),  // POST to response_url (string → ephemeral text)
  defer(fn),     // run fn AFTER the ack; errors go to the boundary chain
  // On kind === 'function' (Slack Workflow Builder custom steps):
  inputs, functionExecutionId, workflowExecutionId,
  complete(outputs),  // calls functions.completeSuccess
  fail(error),        // calls functions.completeError
}
```

### Ack model — return value → HTTP response, per kind

| kind | return → response |
|---|---|
| `command` | `undefined` → empty 200 · string → ephemeral text · message object → JSON body · `Response` → passthrough. In-channel: `message({response_type:'in_channel', ...})` |
| `action` | ack body is meaningless to Slack, so: `undefined` → empty 200; a returned string/message is POSTed to `response_url` post-ack |
| `view` | `view.update(v)/push(v)/errors({block_id: msg})/clear()` → response_action JSON · `undefined` → empty 200 (modal closes) |
| `view_closed` | ignored → empty 200 |
| `shortcut` | `undefined` → 200; returned message → response_url when present |
| `options` | `options([...])` / `optionGroups([...])` → JSON body · `undefined` → `{options: []}` |
| `event` | **return ignored.** Framework acks 200 immediately; `loader` + handler run post-ack. `event.app_home_opened` with `render`: framework calls `views.publish({user_id, view})` (a returned blocks array is wrapped in `{type:'home', blocks}`) |
| `function` | Slack Workflow Builder custom step (`function_executed`). Framework acks 200 immediately; `loader` + handler run post-ack. Returning an outputs object auto-calls `functions.completeSuccess`; throwing auto-calls `functions.completeError`; returning `undefined` leaves the step open for async completion. |

Unmatched anything → acked 200 + logged. The route table is the allow-list;
there is nothing to keep in sync.

### Filename convention (`routes/` dir, flat)

`{kind}.{id}.js` — first dot-segment is the kind, the rest is the id (dots
preserved: `event.message.im.js` → id `message.im`). `command.` ids get `/`
prefixed. `$` compiles to `.*` (`action.row_$.js` → `/^row_.*$/`). Ids that
can't be filenames: `route(kind, idOrRegExp, module)` passed in the `routes`
array. Non-matching `.js` files in the dir are warned about and skipped.

## Errors

```js
import { UserError } from 'remack';
throw new UserError('Pick a client first.');   // user sees this; no ops alert
throw new Error('anything else');              // generic message + ops alert + log
```

Chain: route `ErrorBoundary` (throws → falls through) → `onError` (undefined
return → falls through) → default: structured log `{kind,id,userId,teamId,phase}`,
fire-and-forget `opsAlert` (skipped for UserError), user notification
(commands: in the ack; others: via `response_url`, else
`chat.postEphemeral`), always 200. Post-ack (`defer`, events) errors use the
same chain with `phase:'deferred'`. Boundary logs go through the request
logger, so they carry the `requestId`.

## Logging

Bring any pino-like logger (`debug/info/warn/error(obj, msg)`, optional
`child`); otherwise a console fallback (debug only with `REMACK_DEBUG`).
Per `/events` request:

- `args.log` — child logger bound to `requestId`, `kind`, `id`, `teamId`,
  `userId` (and `app` with a namespace). Use it in handlers.
- One summary line: `Slack request handled` `{status, outcome, ackMs}` at
  info, or `Slow Slack ack` at warn when `ackMs > 2000` (Slack gives up at
  3000). `outcome`: `ok | error | unhandled | unknown_workspace |
  retry_dropped | url_verification | rejected | bad_request`. A throw
  outside the route boundary (e.g. the installation store is down) logs
  `outcome:'crashed'` at error with the `requestId`, then propagates.
- `Slack continuation finished` `{durationMs, continuations, failed}` once
  a request's post-ack work (events, `defer`) has all settled.

`childLogger(logger, bindings)` is exported for the same binding outside
requests (works on loggers without `child`).

## Client

```js
import { createClient, isSlackError } from 'remack';
const client = createClient({ token });
await client.chat.postMessage({ channel, text });     // any method via dot-access
await client.call('chat.postMessage', params);        // same thing
await client.files.upload({ channelId, filename, content /* or bytes */, title, initialComment });
```

- `ok:false` → throws `SlackApiError`; check with `isSlackError(err, 'missing_scope')`.
- 429 → honors Retry-After, `maxRetries` (default 2).
- JSON+bearer by default; `oauth.v2.access` and `files.getUploadURLExternal`
  auto-switch to form encoding (`{encoding:'form'}` to force).
- `files.upload` = getUploadURLExternal → POST bytes → completeUploadExternal,
  with byte-accurate length (multibyte-safe).

## Adapters

```js
import { serve, toNodeHandler } from 'remack';           // or 'remack/node'
const { url, close } = await serve({ fetch: app.fetch, port: 3000, onIdle: app.idle });
expressApp.use('/slack', toNodeHandler(app.fetch));              // Express mount
```

The adapter buffers raw bytes itself. NEVER let `express.json()` (or any
body parser) touch the mount path — signatures are computed over the exact
raw body. A pre-consumed stream raises a descriptive error instead of
mysterious 401s. Express strips the mount prefix, so default paths work at
any mount point. Other runtimes (Bun/Deno/Workers): pass `app.fetch`
directly to the platform's fetch server.

## Hosting & post-ack work

Events and `defer()` run AFTER the response. On a long-running server that
just works (`serve({onIdle: app.idle})` drains it on shutdown). Serverless
platforms freeze the invocation once the response is sent, so the work
must be handed to the platform's `waitUntil`:

```js
// Cloudflare Workers — fetch(request, env, ctx): ctx.waitUntil is found automatically
export default { fetch: (request, env, ctx) => getApp(env).fetch(request, env, ctx) };
// getApp(env) = memoized createApp({ env, ... }) — Workers bindings arrive per request

// Netlify — handler(request, context): context.waitUntil is found automatically
export default (request, context) => app.fetch(request, context);

// Vercel — no ctx arg; pass the global one
import { waitUntil } from '@vercel/functions';
const app = createApp({ waitUntil, ... });
```

`app.fetch(request, ...platformArgs)` uses the first extra arg with a
`waitUntil` method, else `createApp({waitUntil})`, else nothing (in-process,
tracked by `idle()`). The core imports `node:fs`/`node:http` via
`fileStorage`/`serve`, so Workers needs the `nodejs_compat` flag.

## Google Apps Script (`lib/apps-script.js`)

A serverless target on any Google account: `Remack.createAppsScriptApp`
in a script deployed as a web app (execute as me, access Anyone). Same
route modules, args, ack model and boundary chain as `createApp`, with
constraints that are the platform's, not bugs:

| | `createApp` | `createAppsScriptApp` |
|---|---|---|
| Request auth | HMAC signature (`x-slack-signature`) | **No headers on Apps Script** → body verification token (Slack-deprecated, still sent) + secret `?key=` (≥16 chars) on the Request URL, both required, constant-time compared. No replay protection. |
| Handlers | sync or async | **sync only** — a returned Promise is an error (it could never settle before `doPost` returns) |
| Client | `createClient` (fetch, async) | `createGasClient` (UrlFetchApp, returns results directly; same dot-access, `SlackApiError`, 429 Retry-After) |
| Events | acked first, handler post-ack | handler runs **before** the ack (3s budget incl. cold start); return ignored |
| `defer()` / `respond()` | post-ack | `defer` throws (nothing runs after `return`); `respond` posts inline |
| Event retries | `x-slack-retry-num` header | no headers → deduped by `event_id` in CacheService (`dedupeSeconds`, default 3600) |
| Config | options / `env` | options, else Script Properties `SLACK_VERIFICATION_TOKEN`, `SLACK_URL_KEY`, `SLACK_BOT_TOKEN` |
| Crash outside the boundary | logged, rethrown | logged (`outcome:'crashed'`), empty ack — never Apps Script's HTML error page |

Single workspace (bot token) only. Logging is the same summary line per
request (`outcome`, `ackMs`, `requestId` from `Utilities.getUuid`), visible
under Executions. `requestId`/`log` are on args as in core.

Distribution: Apps Script has no modules, so `remack build:apps-script`
bundles `lib/apps-script.js` and its imports into one script defining a
global `Remack` (`lib/cli/bundle.js` — a tiny bundler that only accepts
lib/'s own import/export style and refuses anything else). A prebuilt copy
lives at `dist/apps-script/remack.js` for no-Node setups; a test fails if
it drifts from lib/ (`npm run build:apps-script`). Anything lib/apps-script.js
imports must avoid fetch, URLSearchParams, URL, TextEncoder, crypto,
process, Buffer and timers at runtime — a test runs the bundle on a bare V8
context without them.

## Payload cheat-sheet (where things live per wire shape)

| | command (form) | block_actions | view_submission | event_callback |
|---|---|---|---|---|
| user | `payload.user_id` | `payload.user.id` | `payload.user.id` | `payload.event.user` |
| team | `payload.team_id` | `payload.team.id` | `payload.team.id` | `payload.team_id` |
| channel | `payload.channel_id` | `payload.channel.id` / `container.channel_id` | — | `payload.event.channel` |
| trigger_id | ✓ | ✓ | ✓ | — |
| response_url | ✓ | ✓ | `response_urls[]` only | — |
| input values | `payload.text` | `payload.actions[]` | `payload.view.state.values[block_id][action_id]` | — |

(`args` normalizes user/team/channel/trigger/responseUrl for you; `payload`
is always the raw shape.)

## Hard-won rules (learned in production, enforced or documented here)

- **3-second ack window.** Handlers must return fast; use `defer()`. Events
  are structurally exempt (acked before your code runs).
- **Always ack unknown interactions** — enforced by the framework.
- **`private_metadata` caps at 3KB.** Store a key, keep wizard state
  server-side. It's the only state that survives a modal round-trip.
- **Text blocks cap at 3000 chars** — `splitSlackTextChunks` from
  'remack/helpers'.
- **response_action gotchas**: `errors` keys must be `block_id`s of input
  blocks; `update` needs a complete view; a malformed response_action fails
  silently (modal just closes). Use the `view.*` builders.
- **Scope degradation beats failure**: `ext/file-delivery` falls back to
  inline chunks on `missing_scope`; `users:read.email` needed for
  lookupByEmail.
- **Conditional init**: only create/mount the app when its env is present;
  don't let Slack init failure take down an unrelated service.
- **Event retries**: Slack retries events on slow/non-2xx acks
  (`x-slack-retry-num`) — dropped by default (`ignoreEventRetries`).
- **Alerting never throws** (`ext/ops-alert`) — a failed alert must not fail
  the job that raised it.

## ext/* modules (all optional, zero-dep)

| Import | Exports | Notes |
|---|---|---|
| `ext/postgres-storage.js` | `postgresStorage({pool, table?})` | storage adapter; migrations/001_remack_kv.sql |
| `ext/ops-alert.js` | `createOpsAlert({token?, channel?, client?})` → `{sendOpsAlert}` | never throws |
| `ext/file-delivery.js` | `deliverFileToUser(client, {userId, content, filename, ...})` | missing_scope fallback |
| `ext/plan-block.js` | `buildPlanBlock, createSteps, updateStepProgress, buildCompletionBlocks` | pure Block Kit |
| `ext/feature-access.js` | `createFeatureAccess({storage, features, failOpen?})` | pass `app.storage`; failOpen default true |
| `ext/engagement-tracker.js` | `createEngagementTracker({storage, eventTypes?})` | pass `app.storage`; aggregates computed in JS — bot-scale by design |

## Workflow Builder (`lib/workflow.js` — exported from `remack` and `remack/workflow`)

- **Slack custom workflow steps**: `Schema` (Manifest v2 type constants like
  `Schema.user_id` → `slack#/types/user_id`), `defineFunctionManifest({title,
  description, inputs, outputs})` (export as `manifest` from
  `routes/function.<id>.js` for `remack manifest --inspect`), and
  `defineFunction({id, title, inputs, outputs, default})` (returns a `RouteDef`
  for `createApp({routes})`).
- **In-app multi-step workflows**: `createWorkflow({id, title, steps, storage,
  trigger, onComplete, onError})` — persists run state in `storage` under
  namespace `workflows`, supports human-in-the-loop `pause()` / `resume()`,
  renders Block Kit progress (`renderProgress(run)`), flattens modal values
  (`extractViewValues(payload)`), and generates `RouteDef[]` via
  `workflow.routes()`.

## CLI (`remack`, bin/remack.js — zero-dep, topic:command style)

- `create <dir> [--mode token|oauth] [--name]` — scaffold: package.json
  (file: dep on this repo), app.js, routes/ with working command/action/
  view/event examples, .env.example, README. Refuses to overwrite an
  existing package.json.
- `create <dir> --target apps-script [--name]` — Google Apps Script
  project: Code.js (command/event/home/action examples + `doPost` + a
  `setup()` that creates the URL key), remack.js (the bundle),
  appsscript.json (V8, web app), slack-manifest.json, .claspignore, README
  with the browser-only and clasp paths. Refuses to overwrite a Code.js;
  `--mode oauth` is rejected.
- `build:apps-script [--out remack.js]` — write the Apps Script bundle.
- `dev [entry] [--no-watch]` — spawns `node --watch app.js` with env layered
  process env → `./.env` (built-in parser) → active profile. Fails fast with
  guidance when SLACK_SIGNING_SECRET is missing.
- `routes [--dir routes]` — table of kind/id/exports; filename-derived, with
  best-effort module import for the exports column.
- `manifest [--url U] [--name N] [--oauth] [--inspect] [--out file] [--dir routes]` —
  Slack App Manifest v2 JSON derived from route filenames (never imports user
  code unless `--inspect` is passed): slash_commands from `command.*`,
  shortcuts from `shortcut.*`, custom workflow steps (`functions` +
  `function_executed`) from `function.*`, bot_events from `event.*`,
  interactivity from action/view/shortcut/options/function, app_home from
  `event.app_home_opened`, scopes from event→scope map (incl. `message.im`,
  `message.channels`, `message.groups`, `message.mpim`), `redirect_urls` with
  `--oauth`.
- `manifest:validate`, `manifest:push --app-id A0...`, `manifest:create` —
  call Slack's `apps.manifest.{validate,update,create}` API using
  `SLACK_APP_CONFIG_TOKEN` (`--config-token` or active profile).
- `deploy:gcp [--service S] [--region R] [--project P] [--sync-env] [--set-secrets ...] [--push-manifest] [--app-id A0...] [--dry-run]` —
  runs `gcloud run deploy --source . --allow-unauthenticated --no-cpu-throttling`
  (so `defer()` / event continuations aren't frozen post-ack), reads the live
  `https://…run.app` URL, and optionally pushes it straight into Slack via
  `manifest:push`.
- `profiles`, `profiles:add <name> [--bot-token --signing-secret --client-id
  --client-secret --state-secret --alerts-channel --config-token --app-id]
  [--no-input]`,
  `profiles:use <name>`, `profiles:remove <name>` — credential profiles at
  `$XDG_CONFIG_HOME/remack/config.json` (override dir with
  `REMACK_CONFIG_DIR`), tokens masked in listings, newest add becomes
  active, field→env mapping in `lib/cli/config.js` `PROFILE_ENV_MAP`.

## Testing your bot

`node:test` friendly: build a signed Request (HMAC-SHA256 of
`v0:{ts}:{rawBody}` with the signing secret) and call `app.fetch(request)`
directly; `await app.idle()` to deterministically wait for deferred work.
See `test/fakes.js` (`signedRequest`, `fakeFetch`, `fakePool`) in this repo
for ready-made patterns.

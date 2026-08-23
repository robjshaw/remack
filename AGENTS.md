# slackline — full contract

Zero-dependency Slack framework. ESM, Node ≥ 22, no build step. This file is
the complete reference; the README is the tour.

## Mental model

1. `createApp(options)` returns `{ fetch, client, ready, idle }`. `fetch` is
   a web-standard `(Request) => Promise<Response>` — THE app. Mount it
   anywhere bytes arrive raw.
2. Slack POSTs three wire shapes to one endpoint (`paths.events`,
   default `/events`); slackline verifies, parses, and normalizes them, then
   dispatches to a route module.
3. **The HTTP response is the ack.** A route's return value becomes the
   response body. Slack gives you 3 seconds — do slow work in `defer()`.
4. Errors never become 5xx. They run route `ErrorBoundary` → app `onError` →
   built-in default, and Slack still gets a 200.

## createApp(options)

```js
createApp({
  signingSecret,      // required; default env SLACK_SIGNING_SECRET
  botToken,           // single-token mode; default env SLACK_BOT_TOKEN
  oauth: {            // multi-workspace mode (used when botToken is absent)
    clientId, clientSecret, stateSecret,   // all required
    scopes,           // required; MUST match your app manifest
    userScopes,       // optional
    store,            // required; { get, set, delete } — see ext/installation-store
    redirectUri,      // optional explicit redirect_uri
  },
  routes,             // dir (string|URL) for fs discovery, RouteDef[], or mixed array
  context,            // object injected into every args (your services/pools)
  onError,            // (error, args) => ackValue|void — app error boundary
  opsAlert,           // (title, {error, context}) => — e.g. ext/ops-alert sendOpsAlert
  logger,             // pino-like; console fallback otherwise
  paths,              // { events:'/events', install:'/install', redirect:'/oauth_redirect' }
  ignoreEventRetries, // default true: drop x-slack-retry-num duplicates
  genericMessage,     // default 'Something went wrong. Please try again.'
}) => { fetch, client /* single-token client or null */, ready /* routes loaded */, idle() }
```

Mode: `botToken` present → single-token. Else `oauth` → per-request token
lookup via `store.get({teamId, enterpriseId, isEnterpriseInstall})`; unknown
workspace acks 200 (never 500); `app_uninstalled`/`tokens_revoked` events
auto-call `store.delete`. OAuth endpoints: GET `paths.install` (302 to Slack,
HMAC state + cookie CSRF, 10-min expiry), GET `paths.redirect` (code exchange
via form-encoded `oauth.v2.access`, then `store.set(installation)`).

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
  kind,          // 'command'|'action'|'view'|'view_closed'|'shortcut'|'options'|'event'
  id,            // '/report' | action_id | callback_id | event type
  payload,       // FULL parsed body — the raw Slack payload, nothing hidden
  teamId, userId, channelId, triggerId, responseUrl,   // null when absent
  client,        // token-bound API client for this workspace
  context,       // what you passed to createApp
  data,          // loader result
  respond(msg),  // POST to response_url (string → ephemeral text)
  defer(fn),     // run fn AFTER the ack; errors go to the boundary chain
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
import { UserError } from '@tbp/slackline';
throw new UserError('Pick a client first.');   // user sees this; no ops alert
throw new Error('anything else');              // generic message + ops alert + log
```

Chain: route `ErrorBoundary` (throws → falls through) → `onError` (undefined
return → falls through) → default: structured log `{kind,id,userId,teamId,phase}`,
fire-and-forget `opsAlert` (skipped for UserError), user notification
(commands: in the ack; others: via `response_url`, else
`chat.postEphemeral`), always 200. Post-ack (`defer`, events) errors use the
same chain with `phase:'deferred'`.

## Client

```js
import { createClient, isSlackError } from '@tbp/slackline';
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
import { serve, toNodeHandler } from '@tbp/slackline';           // or '@tbp/slackline/node'
const { url, close } = await serve({ fetch: app.fetch, port: 3000, onIdle: app.idle });
expressApp.use('/slack', toNodeHandler(app.fetch));              // Express mount
```

The adapter buffers raw bytes itself. NEVER let `express.json()` (or any
body parser) touch the mount path — signatures are computed over the exact
raw body. A pre-consumed stream raises a descriptive error instead of
mysterious 401s. Express strips the mount prefix, so default paths work at
any mount point. Other runtimes (Bun/Deno/Workers): pass `app.fetch`
directly to the platform's fetch server.

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
  '@tbp/slackline/helpers'.
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

## ext/* modules (all optional, zero-dep, pool injected — never `pg` imported)

| Import | Exports | Notes |
|---|---|---|
| `ext/installation-store.js` | `createInstallationStore({pool, table?})` → `{get,set,delete,list}` | migrations/001 |
| `ext/ops-alert.js` | `createOpsAlert({token?, channel?, client?})` → `{sendOpsAlert}` | never throws |
| `ext/file-delivery.js` | `deliverFileToUser(client, {userId, content, filename, ...})` | missing_scope fallback |
| `ext/plan-block.js` | `buildPlanBlock, createSteps, updateStepProgress, buildCompletionBlocks` | pure Block Kit |
| `ext/feature-access.js` | `createFeatureAccess({pool, features, failOpen?, tables?})` | migrations/003; failOpen default true |
| `ext/engagement-tracker.js` | `createEngagementTracker({pool, eventTypes?, tables?})` | migrations/002; `defineTracker` for app-specific track maps |

## Testing your bot

`node:test` friendly: build a signed Request (HMAC-SHA256 of
`v0:{ts}:{rawBody}` with the signing secret) and call `app.fetch(request)`
directly; `await app.idle()` to deterministically wait for deferred work.
See `test/fakes.js` (`signedRequest`, `fakeFetch`, `fakePool`) in this repo
for ready-made patterns.

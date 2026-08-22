# boltkit

Batteries-included toolkit for building Slack bots on [@slack/bolt](https://slack.dev/bolt-js).

Extracted from a production bot (panther) — the reusable framework layer plus
the lessons learned building it. It is **not a bot**: it's the plumbing every
bot needs (auth bootstrap, OAuth storage, handler structure, error handling,
analytics, feature gating) so a new bot starts at the business logic.

## What's in the box

| Module | Factory | What it does |
|---|---|---|
| `create-app` | `createSlackApp()` | Dual-mode (token/OAuth) Bolt bootstrap; returns `{app, receiver, registrar, mode}` |
| `registrar` | `createRegistrar()` | Handler-module pattern; derives catch-all fallbacks from what's registered |
| `errors` | `createErrorHandler()`, `SlackUserError` | Central error handling: ack-first, log, ops alert, ephemeral user message |
| `installation-store` | `createInstallationStore()` | Postgres-backed Bolt InstallationStore (workspace + Enterprise Grid) |
| `ops-alert` | `createOpsAlert()` | Fire-and-forget alert channel for background jobs; never throws |
| `engagement-tracker` | `createEngagementTracker()` | Home-tab engagement + unified analytics event stream |
| `feature-access` | `createFeatureAccess()` | Invite-only ring-fencing for pilot features, with audit log |
| `user-lookup` | `createUserLookup()` | Staff name → email → Slack user, with cache and test-mode redirect |
| `file-delivery` | `deliverFileToUser()` | DM a file via `files.uploadV2`, inline-chunk fallback on `missing_scope` |
| `plan-block` | `buildPlanBlock()` etc. | Step-by-step progress UI for async operations |
| `helpers` | `ackSafely()` etc. | Ack safety, concurrency mapping, 3000-char chunking, misc |

## Quickstart

```js
const { createSlackApp, createErrorHandler } = require('@tbp/boltkit');

const pingModule = {
  name: 'ping',
  register(r, deps) {
    r.command('/ping', async ({ ack }) => { await ack('pong'); });
  },
};

const { app } = createSlackApp({
  errorHandler: createErrorHandler({}),
  modules: [pingModule],
});

await app.start(process.env.PORT || 3000);
```

See `examples/minimal-bot/` for a runnable version.

### Environment variables

The library only reads env as *defaults* for `createSlackApp` and
`createOpsAlert` options — explicit options always win, and it never reads
`DATABASE_URL` (inject a `pg` Pool instead).

| Variable | Used by | Purpose |
|---|---|---|
| `SLACK_BOT_TOKEN` | createSlackApp, createOpsAlert | Single-token mode bot token |
| `SLACK_SIGNING_SECRET` | createSlackApp | Request signature verification (required) |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | createSlackApp | OAuth mode credentials |
| `SLACK_STATE_SECRET` | createSlackApp | OAuth state parameter secret (required in OAuth mode) |
| `SLACK_ALERTS_CHANNEL` | createOpsAlert | Channel for ops alerts |
| `BOLTKIT_DEBUG` | fallback logger | Enable debug output when no logger injected |

## Auth modes

`createSlackApp` auto-detects the mode:

- **Single-token** — `botToken` (or `SLACK_BOT_TOKEN`) set. Simple, one
  workspace. This is where every bot starts.
- **OAuth** — no bot token, but `clientId` set. Requires `clientSecret`,
  `stateSecret`, `scopes`, and an `installationStore` — use
  `createInstallationStore({ pool })` with `migrations/001_slack_installations.sql`.
  `directInstall: true` (default) skips the "Add to Slack" landing page.
  Install lands at `<mount-path>/install`.

**Scopes must match your app manifest.** In OAuth mode you must pass them
explicitly; `DEFAULT_SCOPES` is exported as a starting template for an
interactive bot (`commands`, `chat:write`, `users:read.email`, ...).

## Mounting in an existing Express app — the raw-body caveat

Bolt verifies request signatures against the **raw request body**. If a
`body-parser`/`express.json()` middleware consumes the body before Bolt sees
it, every Slack request fails signature verification. When mounting the
receiver into an existing Express app, skip body parsing for the Slack path:

```js
const { app: slackApp, receiver } = createSlackApp({ ... });

// Body parsing for everything EXCEPT /slack — Bolt needs the raw body
expressApp.use((req, res, next) => {
  if (req.path.startsWith('/slack')) return next();
  express.json()(req, res, next);
});

expressApp.use('/slack', receiver.router);
// Events now land on /slack/events, OAuth install on /slack/install
```

Standalone bots can just call `app.start(port)` and skip all of this.

## Handler modules & the registrar

The failure mode this prevents: one 10,000-line function with ~95 inline
closures, plus a hand-maintained allow-list of action IDs feeding a catch-all
fallback — which silently breaks the first time someone adds a handler and
forgets the list.

A handler module is `{ name, register(r, deps) }`. The registrar `r` mirrors
Bolt's API (`command`, `action`, `view`, `event`, `shortcut`, `options`,
`message`); every registration is recorded and wrapped with the central error
handler. `deps` is whatever you pass in — services, pools, config — so
modules are testable without globals.

```js
const { registrar } = createSlackApp({ ... });
registrar.use(wipModule);
registrar.use(reportsModule);
registrar.finalize(); // installs catch-all fallbacks

// or equivalently: createSlackApp({ modules: [wipModule, reportsModule] })
```

`finalize()` installs `action`/`view`/`event` catch-alls that ack anything no
module registered (Slack always gets a timely acknowledgement, so users never
see the ⚠️ timeout), and defer to dedicated handlers for everything recorded —
the "handled" set is derived, never maintained by hand. Duplicate string-ID
registrations log a warning.

## Central error handling

```js
const { sendOpsAlert } = createOpsAlert({ channel: '#my-bot-ops' });
const errorHandler = createErrorHandler({
  opsAlert: sendOpsAlert,
  onError: (err, ctx) => Sentry.captureException(err, { extra: ctx }),
});
```

Every wrapped handler that throws gets: **ack first** (no Slack retry/timeout),
a structured log with `{module, kind, id, userId, teamId}`, the `onError`
hook, an ops alert, and an ephemeral "Something went wrong" to the user.
Throw `SlackUserError('Pick a client first.')` for expected user-facing
failures — the user sees your message and no ops alert fires.
`createSlackApp` also wires `app.error(globalHandler)` for errors outside
handlers.

## Database features

All DB modules take an injected `pool` (anything with
`query(text, params) → {rows}`) — the library never creates connections.
Run the migrations with your app's runner:

```
psql $DATABASE_URL -f node_modules/@tbp/boltkit/migrations/001_slack_installations.sql
psql $DATABASE_URL -f node_modules/@tbp/boltkit/migrations/002_slack_analytics.sql
psql $DATABASE_URL -f node_modules/@tbp/boltkit/migrations/003_feature_access.sql
```

Table names are injectable (validated identifiers) if your schema differs.

**Engagement tracker** — event types are yours, injected:

```js
const tracker = createEngagementTracker({
  pool,
  eventTypes: { SEARCH_COMPLETED: 'search_completed' },
});
const track = {
  searchCompleted: tracker.defineTracker(tracker.EventType.SEARCH_COMPLETED, { feature: 'search' }),
};
await track.searchCompleted({ userId, searchQuery: 'acme', resultCount: 9 });
```

**Feature access** — feature registry is yours, injected; `failOpen: true`
(default) preserves "no DB / DB error → allow" semantics, set `false` for
fail-closed:

```js
const access = createFeatureAccess({
  pool,
  features: {
    'my-pilot': { key: 'my_pilot', name: 'My Pilot', status: 'pilot', requiresAccess: true, docsUrl: 'https://…' },
  },
});
if (!await access.hasAccess('my-pilot', userId)) {
  await access.logAccessDenied('my-pilot', userId, userName, channelId);
  return respond(access.buildNoAccessMessage('my-pilot'));
}
```

## Hard-won learnings

Lessons from production baked into this library — and the ones you still have
to respect in your own handlers:

- **The 3-second ack window.** Slack retries (and shows users an error) if a
  handler doesn't ack within 3 seconds. Ack immediately, then do the work.
  `ackSafely` exists because multiple listeners can race to ack the same
  request (`ReceiverMultipleAckError`) and late acks throw
  (`HTTPReceiverDeferredRequestError`) — both are normal and safe to swallow.
- **Always have catch-all fallbacks** for actions/views/events you don't
  handle, or users see timeout warnings on stray interactions. The registrar's
  `finalize()` does this with a derived allow-list.
- **`private_metadata` caps at 3KB.** It's the only state that survives a
  modal round-trip, and complex wizards will hit the cap. Store a key
  (e.g. a row ID) in `private_metadata` and keep the state server-side.
- **Slack text blocks cap at 3000 characters.** Chunk long content
  (`splitSlackTextChunks`) or deliver as a file.
- **Scope degradation beats scope failure.** `deliverFileToUser` falls back
  to inline chunked DMs when `files:write` is missing; `users:read.email` is
  required for lookup-by-email. Detect `missing_scope` and degrade.
- **Conditional init.** Only start the Slack app when its env is present
  (`if (SLACK_BOT_TOKEN && SLACK_SIGNING_SECRET)`) so the rest of your
  service boots in environments without Slack configured — and don't let a
  Slack init failure take the whole service down.
- **Raw body for signature verification** when mounting into Express (see
  above) — the single most common "nothing works" cause.
- **Alerting must never be the reason a job fails.** `createOpsAlert` logs
  and returns instead of throwing, always.
- **`@slack/web-api` must be a direct dependency** if you use `WebClient`
  outside Bolt — relying on it transitively via Bolt breaks on hoisting
  changes.

## Design notes

- **Dependency injection everywhere.** Factories take `pool`, `logger`,
  and config objects; the library never calls `new Pool()`, never reads
  `DATABASE_URL`, never calls `dotenv.config()`. Any pino-like logger works;
  without one, a console fallback is used.
- **CommonJS, no build step.** Matches the consuming codebases; JSDoc
  typedefs provide IntelliSense. Revisit TypeScript if a TS-first consumer
  appears.
- **Bolt is a real dependency** (not a peer) because `ackSafely` imports its
  `ErrorCode` enum. Keep your app's Bolt on the same major so the enums and
  receiver classes resolve consistently.

## Development

```
npm install
npm test          # node:test, no DB or Slack needed
npm run example   # runs examples/minimal-bot (needs .env)
```

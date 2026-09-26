import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAppsScriptApp, createGasClient, route, view, UserError, isSlackError } from '../lib/apps-script.js';
import { buildAppsScript } from '../lib/cli/commands/build.js';
import { main } from '../lib/cli/index.js';
import { fakeLogger } from './fakes.js';
import * as payloads from './fixtures/payloads.js';

const TOKEN = 'verif-token-123';
const KEY = 'k'.repeat(24);

/** Fake Apps Script services: UrlFetchApp, ContentService, CacheService, PropertiesService, Utilities. */
function fakeGas({ props = {}, respond = () => ({ ok: true }) } = {}) {
  const fetches = [];
  const sleeps = [];
  const cache = new Map();
  const services = {
    fetches,
    sleeps,
    cache,
    UrlFetchApp: {
      fetch(url, options) {
        fetches.push({ url, options, body: options.payload ? JSON.parse(options.payload) : undefined });
        const reply = respond(url, options);
        const status = reply?.__status ?? 200;
        return {
          getResponseCode: () => status,
          getHeaders: () => reply?.__headers ?? {},
          getContentText: () => (typeof reply?.__raw === 'string' ? reply.__raw : JSON.stringify(reply)),
        };
      },
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput(text) {
        const out = { text, mimeType: null, setMimeType(mime) { out.mimeType = mime; return out; } };
        return out;
      },
    },
    CacheService: {
      getScriptCache: () => ({ get: (key) => cache.get(key) ?? null, put: (key, value) => cache.set(key, value) }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...props }) }) },
    Utilities: { getUuid: () => 'uuid-1', sleep: (ms) => sleeps.push(ms) },
  };
  return services;
}

/** Build the doPost event object Apps Script would hand us. */
function gasEvent(body, { key = KEY } = {}) {
  const form = body instanceof URLSearchParams;
  const contents = form ? body.toString() : JSON.stringify(body);
  return {
    queryString: key === null ? null : `key=${encodeURIComponent(key)}`,
    parameter: key === null ? {} : { key },
    postData: { type: form ? 'application/x-www-form-urlencoded' : 'application/json', contents, length: contents.length },
  };
}

const command = (overrides = {}) => new URLSearchParams({
  ...Object.fromEntries(payloads.slashCommandForm), token: TOKEN, ...overrides,
});
const interactive = (payload) => new URLSearchParams({ payload: JSON.stringify({ ...payload, token: TOKEN }) });
const event = (payload) => ({ ...payload, token: TOKEN });

function makeApp({ routes = [], services = fakeGas(), ...overrides } = {}) {
  const logger = fakeLogger();
  const app = createAppsScriptApp({
    verificationToken: TOKEN, urlKey: KEY, botToken: 'xoxb-gas', routes, services, logger, ...overrides,
  });
  return { app, services, logger };
}

const json = (out) => JSON.parse(out.text);
const summary = (logger) => logger.entries.filter((e) => /Slack request handled|Slow Slack ack/.test(e.msg)).map((e) => e.objOrMsg);

// ── Configuration ────────────────────────────────────────────────────────────

test('requires verification token, a long url key, and a bot token — from options or Script Properties', () => {
  const base = { services: fakeGas(), logger: fakeLogger() };
  assert.throws(() => createAppsScriptApp({ ...base, urlKey: KEY, botToken: 'x' }), /verificationToken/);
  assert.throws(() => createAppsScriptApp({ ...base, verificationToken: TOKEN, urlKey: 'short', botToken: 'x' }), /urlKey.*16/);
  assert.throws(() => createAppsScriptApp({ ...base, verificationToken: TOKEN, urlKey: KEY }), /botToken/);

  const fromProps = createAppsScriptApp({
    services: fakeGas({ props: { SLACK_VERIFICATION_TOKEN: TOKEN, SLACK_URL_KEY: KEY, SLACK_BOT_TOKEN: 'xoxb-props' } }),
    logger: fakeLogger(),
  });
  assert.equal(fromProps.client.token, 'xoxb-props');
});

// ── Authentication ───────────────────────────────────────────────────────────

test('rejects a missing or wrong ?key= and a wrong body token without running routes', () => {
  let ran = 0;
  const { app, logger } = makeApp({ routes: [route('command', '/report', { default: () => { ran++; return 'hi'; } })] });

  for (const e of [
    gasEvent(command(), { key: null }),
    gasEvent(command(), { key: 'x'.repeat(24) }),
    gasEvent(command({ token: 'forged' })),
  ]) {
    const out = app.doPost(e);
    assert.equal(out.text, '');
  }
  assert.equal(ran, 0);
  assert.deepEqual(summary(logger).map((s) => s.outcome), ['rejected', 'rejected', 'rejected']);
});

test('the key must be in the query string: a form field named key does not count', () => {
  let ran = 0;
  const { app } = makeApp({ routes: [route('command', '/report', { default: () => { ran++; } })] });
  const e = gasEvent(command({ key: KEY }), { key: null });
  e.parameter = { key: KEY }; // Apps Script merges form fields into e.parameter
  app.doPost(e);
  assert.equal(ran, 0);
});

test('url_verification echoes the challenge once the token checks out', () => {
  const { app } = makeApp();
  const out = app.doPost(gasEvent(event(payloads.urlVerification)));
  assert.deepEqual(json(out), { challenge: payloads.urlVerification.challenge });

  const forged = app.doPost(gasEvent(payloads.urlVerification));
  assert.equal(forged.text, '');
});

// ── Ack model ────────────────────────────────────────────────────────────────

test('command: string return is an ephemeral JSON ack; args match createApp', () => {
  let seen;
  const { app, logger } = makeApp({
    routes: [route('command', '/report', {
      loader: ({ payload }) => payload.text.toUpperCase(),
      default: (args) => { seen = args; return `Running ${args.data}`; },
    })],
  });

  const out = app.doPost(gasEvent(command()));
  assert.equal(out.mimeType, 'JSON');
  assert.deepEqual(json(out), { response_type: 'ephemeral', text: 'Running WEEKLY' });
  assert.equal(seen.kind, 'command');
  assert.equal(seen.userId, 'U333');
  assert.equal(seen.requestId, 'uuid-1');
  assert.equal(summary(logger)[0].outcome, 'ok');
  assert.equal(summary(logger)[0].requestId, 'uuid-1');
});

test('view: response_action JSON round-trips', () => {
  const { app } = makeApp({
    routes: [route('view', 'settings', { default: () => view.errors({ b1: 'Nope' }) })],
  });
  const out = app.doPost(gasEvent(interactive(payloads.viewSubmission)));
  assert.deepEqual(json(out), { response_action: 'errors', errors: { b1: 'Nope' } });
});

test('action: empty ack; a returned message is POSTed to response_url inline', () => {
  const { app, services } = makeApp({
    routes: [route('action', 'open_settings', { default: () => 'Saved!' })],
  });
  const out = app.doPost(gasEvent(interactive(payloads.blockActions)));
  assert.equal(out.text, '');
  assert.equal(services.fetches.length, 1);
  assert.equal(services.fetches[0].url, payloads.blockActions.response_url);
  assert.deepEqual(services.fetches[0].body, { response_type: 'ephemeral', text: 'Saved!' });
});

test('options: undefined return acks an empty options list; unmatched acks empty', () => {
  const { app, logger } = makeApp({ routes: [route('options', 'project_picker', { default: () => undefined })] });
  const suggestion = { ...payloads.blockSuggestion, action_id: 'project_picker' };
  assert.deepEqual(json(app.doPost(gasEvent(interactive(suggestion)))), { options: [] });

  const unmatched = app.doPost(gasEvent(interactive(payloads.blockActions)));
  assert.equal(unmatched.text, '');
  assert.equal(summary(logger)[1].outcome, 'unhandled');
});

// ── Events ───────────────────────────────────────────────────────────────────

test('events run inline with a synchronous client; retries are dropped by event_id', () => {
  const posted = [];
  const { app, services, logger } = makeApp({
    routes: [route('event', 'app_mention', {
      default: ({ client, channelId }) => { posted.push(client.chat.postMessage({ channel: channelId, text: 'hi' })); },
    })],
    services: fakeGas({ respond: () => ({ ok: true, ts: '1.2' }) }),
  });

  const first = app.doPost(gasEvent(event(payloads.eventCallback)));
  assert.equal(first.text, '');
  assert.deepEqual(posted, [{ ok: true, ts: '1.2' }], 'client call returned its result synchronously');
  assert.equal(services.fetches[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(services.fetches[0].options.headers.Authorization, 'Bearer xoxb-gas');

  app.doPost(gasEvent(event(payloads.eventCallback)));
  assert.equal(posted.length, 1, 'retry with the same event_id is dropped');
  assert.equal(summary(logger)[1].outcome, 'retry_dropped');
});

test('app_home_opened with render publishes the home view', () => {
  const { app, services } = makeApp({
    routes: [route('event', 'app_home_opened', { render: () => [{ type: 'section', text: { type: 'mrkdwn', text: 'Hi' } }] })],
  });
  app.doPost(gasEvent(event(payloads.homeOpenedEvent)));
  assert.equal(services.fetches[0].url, 'https://slack.com/api/views.publish');
  assert.equal(services.fetches[0].body.view.type, 'home');
  assert.equal(services.fetches[0].body.user_id, payloads.homeOpenedEvent.event.user);
});

// ── Errors ───────────────────────────────────────────────────────────────────

test('an async handler is a loud error, not a silent no-op', () => {
  const { app, logger } = makeApp({ routes: [route('command', '/report', { default: async () => 'never' })] });
  const out = app.doPost(gasEvent(command()));
  assert.deepEqual(json(out), { response_type: 'ephemeral', text: 'Something went wrong. Please try again.' });
  const line = logger.entries.find((e) => e.msg === 'Unhandled error in Slack route');
  assert.match(line.objOrMsg.err.message, /returned a Promise.*synchronously/);
});

test('UserError in an action reaches the user via response_url; ErrorBoundary wins over onError', () => {
  const { app, services } = makeApp({
    routes: [route('action', 'open_settings', { default: () => { throw new UserError('Pick a client first.'); } })],
  });
  app.doPost(gasEvent(interactive(payloads.blockActions)));
  assert.equal(services.fetches[0].body.text, 'Pick a client first.');

  const bounded = makeApp({
    routes: [route('command', '/report', {
      default: () => { throw new Error('x'); },
      ErrorBoundary: ({ error }) => `Boundary: ${error.message}`,
    })],
    onError: () => 'onError',
  });
  assert.equal(json(bounded.app.doPost(gasEvent(command()))).text, 'Boundary: x');
});

test('defer() throws a descriptive error that goes through the boundary chain', () => {
  const { app, logger } = makeApp({
    routes: [route('command', '/report', { default: ({ defer }) => { defer(() => {}); } })],
  });
  app.doPost(gasEvent(command()));
  const line = logger.entries.find((e) => e.msg === 'Unhandled error in Slack route');
  assert.match(line.objOrMsg.err.message, /defer\(\) is unavailable on Apps Script/);
});

test('a crash outside the boundary still returns an empty ack, never an error page', () => {
  const services = fakeGas();
  services.CacheService.getScriptCache = () => { throw new Error('cache down'); };
  const { app, logger } = makeApp({ services, routes: [route('event', 'app_mention', { default: () => {} })] });
  const out = app.doPost(gasEvent(event(payloads.eventCallback)));
  assert.equal(out.text, '');
  assert.equal(summary(logger)[0].outcome, 'crashed');
});

// ── Client ───────────────────────────────────────────────────────────────────

test('createGasClient: dot-access, ok:false throws SlackApiError, 429 honors Retry-After', () => {
  let calls = 0;
  const services = fakeGas({
    respond: () => {
      calls += 1;
      if (calls === 1) return { __status: 429, __headers: { 'Retry-After': '2' }, __raw: '' };
      if (calls === 2) return { ok: true, user: { id: 'U1' } };
      return { ok: false, error: 'missing_scope' };
    },
  });
  const client = createGasClient({ token: 'xoxb', UrlFetchApp: services.UrlFetchApp, sleep: (ms) => services.sleeps.push(ms) });

  assert.deepEqual(client.users.info({ user: 'U1' }), { ok: true, user: { id: 'U1' } });
  assert.deepEqual(services.sleeps, [2000]);
  assert.throws(() => client.chat.postMessage({}), (err) => isSlackError(err, 'missing_scope'));
  assert.equal(client.then, undefined, 'never looks like a thenable');
});

// ── The bundle, on a bare V8 like Apps Script's ─────────────────────────────

test('the Apps Script bundle runs with no Node or web-platform globals', async () => {
  const source = await buildAppsScript();
  const services = fakeGas({
    props: { SLACK_VERIFICATION_TOKEN: TOKEN, SLACK_URL_KEY: KEY, SLACK_BOT_TOKEN: 'xoxb-bundle' },
    respond: () => ({ ok: true }),
  });
  const logs = [];
  const silentConsole = Object.fromEntries(['debug', 'info', 'warn', 'error', 'log']
    .map((level) => [level, (...args) => logs.push([level, ...args])]));

  // A fresh context has ECMAScript builtins only: no fetch, URLSearchParams,
  // URL, TextEncoder, crypto, process, Buffer, setTimeout — as on Apps Script.
  const context = vm.createContext({ console: silentConsole, ...services });
  for (const name of ['fetch', 'URLSearchParams', 'URL', 'TextEncoder', 'crypto', 'process', 'Buffer', 'setTimeout', 'structuredClone']) {
    assert.equal(vm.runInContext(`typeof ${name}`, context), 'undefined', `${name} leaked into the test context`);
  }

  vm.runInContext(source, context, { filename: 'slackline.js' });
  // What a user's Code.js looks like
  vm.runInContext(`
    var __app;
    function app() {
      return __app || (__app = Slackline.createAppsScriptApp({
        routes: [
          Slackline.route('command', '/report', { default: function (args) { return 'pong ' + args.payload.text; } }),
          Slackline.route('event', 'app_mention', { default: function (args) { args.client.chat.postMessage({ channel: args.channelId, text: 'hi' }); } }),
        ],
      }));
    }
    function doPost(e) { return app().doPost(e); }
  `, context, { filename: 'Code.js' });

  const out = context.doPost(gasEvent(command()));
  assert.deepEqual(JSON.parse(out.text), { response_type: 'ephemeral', text: 'pong weekly' });

  context.doPost(gasEvent(event(payloads.eventCallback)));
  assert.equal(services.fetches.at(-1).url, 'https://slack.com/api/chat.postMessage');
  assert.equal(services.fetches.at(-1).options.headers.Authorization, 'Bearer xoxb-bundle');

  assert.ok(logs.some(([, msg]) => msg === 'Slack request handled'), 'console fallback logger works without process');
});

// ── The scaffold and the shipped bundle ─────────────────────────────────────

/** Load script files into a bare-V8 context with fake Apps Script services. */
function gasProject(sources, services) {
  const logs = [];
  const console = Object.fromEntries(['debug', 'info', 'warn', 'error', 'log']
    .map((level) => [level, (...args) => logs.push([level, ...args])]));
  const context = vm.createContext({ console, ...services });
  for (const [filename, source] of sources) vm.runInContext(source, context, { filename });
  return { context, logs };
}

test('create --target apps-script scaffolds a project whose Code.js works end to end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slackline-gas-'));
  try {
    let output = '';
    const io = { stdout: { write: (chunk) => { output += chunk; } } };
    assert.equal(await main(['create', dir, '--target', 'apps-script', '--name', 'gas-bot'], io), 0);
    assert.match(output, /Google Apps Script/);

    const read = (file) => readFile(join(dir, file), 'utf8');
    const appsscript = JSON.parse(await read('appsscript.json'));
    assert.deepEqual(appsscript.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
    assert.equal(appsscript.runtimeVersion, 'V8');

    const manifest = JSON.parse(await read('slack-manifest.json'));
    assert.equal(manifest.features.slash_commands[0].command, '/ping');
    assert.match(manifest.settings.event_subscriptions.request_url, /\/exec\?key=YOUR_URL_KEY$/);
    assert.deepEqual(manifest.settings.event_subscriptions.bot_events, ['app_home_opened', 'app_mention']);

    // Run setup() first, the way the README says, against real-ish properties
    const store = { SLACK_VERIFICATION_TOKEN: TOKEN, SLACK_BOT_TOKEN: 'xoxb-scaffold' };
    const services = fakeGas();
    services.PropertiesService = {
      getScriptProperties: () => ({
        getProperties: () => ({ ...store }),
        getProperty: (k) => store[k] ?? null,
        setProperty: (k, v) => { store[k] = v; },
      }),
    };
    let uuid = 0;
    services.Utilities.getUuid = () => `0000-${String(++uuid).padStart(4, '0')}`;

    // Apps Script loads files in project order; Code.js first proves the lazy app() wiring
    const { context, logs } = gasProject([
      ['Code.js', await read('Code.js')],
      ['slackline.js', await read('slackline.js')],
    ], services);

    context.setup();
    const key = store.SLACK_URL_KEY;
    assert.ok(key && key.length >= 16, 'setup() created a URL key');
    assert.ok(logs.some(([, line]) => String(line).includes(`?key=${key}`)));
    context.setup();
    assert.equal(store.SLACK_URL_KEY, key, 'setup() is idempotent');

    const ping = context.doPost(gasEvent(command({ command: '/ping' }), { key }));
    assert.deepEqual(JSON.parse(ping.text), { response_type: 'ephemeral', text: 'pong 🏓' });

    context.doPost(gasEvent(event(payloads.eventCallback), { key }));
    const mention = services.fetches.at(-1);
    assert.equal(mention.url, 'https://slack.com/api/chat.postMessage');
    assert.equal(mention.body.thread_ts, payloads.eventCallback.event.ts);

    context.doPost(gasEvent(event(payloads.homeOpenedEvent), { key }));
    assert.equal(services.fetches.at(-1).url, 'https://slack.com/api/views.publish');

    const click = { ...payloads.blockActions, actions: [{ action_id: 'say_hi', type: 'button' }] };
    delete click.response_url;
    context.doPost(gasEvent(interactive(click), { key }));
    const published = services.fetches.at(-1).body;
    assert.equal(published.user_id, payloads.blockActions.user.id);
    assert.equal(published.view.blocks.length, 3, 'home view re-rendered with the click time');

    assert.equal(await main(['create', dir, '--target', 'apps-script'], io), 1, 'refuses to overwrite');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dist/apps-script/slackline.js is up to date with lib/ (run: npm run build:apps-script)', async () => {
  const shipped = await readFile(new URL('../dist/apps-script/slackline.js', import.meta.url), 'utf8');
  assert.equal(shipped, await buildAppsScript());
});

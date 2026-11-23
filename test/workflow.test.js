import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createApp,
  route,
  UserError,
  memoryStorage,
  Schema,
  defineFunction,
  defineFunctionManifest,
  createWorkflow,
  pause,
  extractViewValues,
} from '../lib/index.js';
import { parseSlackRequest } from '../lib/parse.js';
import { parseRouteFilename } from '../lib/routes-fs.js';
import { createAppsScriptApp } from '../lib/apps-script.js';
import { buildManifest, scanRoutes } from '../lib/cli/commands/manifest.js';
import { main as runCli } from '../lib/cli/index.js';
import { signedRequest, fakeFetch, fakeLogger, TEST_SIGNING_SECRET } from './fakes.js';

function functionExecutedEnvelope(callbackId, inputs = {}, overrides = {}) {
  return {
    type: 'event_callback',
    team_id: 'T123',
    event_id: 'EvFn1',
    token: 'verify-tok',
    event: {
      type: 'function_executed',
      function: { callback_id: callbackId },
      inputs,
      function_execution_id: 'Fx123456',
      workflow_execution_id: 'Wx999999',
      event_ts: '1700000000.000100',
      ...overrides,
    },
  };
}

function withFakeGlobalFetch(fn) {
  const original = globalThis.fetch;
  const mock = fakeFetch(() => ({ ok: true }));
  globalThis.fetch = mock;
  return Promise.resolve()
    .then(() => fn(mock))
    .finally(() => { globalThis.fetch = original; });
}

function captureIo(extra = {}) {
  let out = '';
  return {
    io: {
      stdout: { write: (chunk) => { out += chunk; } },
      stdin: { isTTY: false },
      ...extra,
    },
    output: () => out,
  };
}

// ── 1. Parsing & Route discovery ─────────────────────────────────────────────

test('parseSlackRequest normalizes function_executed into kind=function', () => {
  const envelope = functionExecutedEnvelope('prep_ingredients', {
    user_id: 'U42',
    channel_id: 'C99',
    dish: 'pasta',
  });
  const req = parseSlackRequest({
    contentType: 'application/json',
    rawBody: JSON.stringify(envelope),
  });

  assert.equal(req.kind, 'function');
  assert.equal(req.id, 'prep_ingredients');
  assert.equal(req.userId, 'U42');
  assert.equal(req.channelId, 'C99');
  assert.equal(req.functionExecutionId, 'Fx123456');
  assert.equal(req.workflowExecutionId, 'Wx999999');
  assert.deepEqual(req.inputs, { user_id: 'U42', channel_id: 'C99', dish: 'pasta' });
});

test('parseRouteFilename recognizes function.<callback_id>.js', () => {
  assert.deepEqual(parseRouteFilename('function.prep_ingredients.js'), {
    kind: 'function',
    id: 'prep_ingredients',
  });
});

// ── 2. Slack Workflow Builder custom steps in createApp ──────────────────────

test('function route: returned outputs object auto-calls functions.completeSuccess', async () => {
  await withFakeGlobalFetch(async (mockFetch) => {
    const step = defineFunction({
      id: 'greet_user',
      title: 'Greet User',
      inputs: {
        user_id: { type: Schema.user_id, title: 'User', required: true },
      },
      outputs: {
        greeting: { type: Schema.string, title: 'Greeting', required: true },
      },
      default: async ({ inputs }) => ({ greeting: `Hello <@${inputs.user_id}>!` }),
    });

    const app = createApp({
      signingSecret: TEST_SIGNING_SECRET,
      botToken: 'xoxb-test',
      routes: [step],
      logger: fakeLogger(),
    });

    const res = await app.fetch(signedRequest({
      body: functionExecutedEnvelope('greet_user', { user_id: 'U77' }),
    }));
    assert.equal(res.status, 200);
    await app.idle();

    assert.equal(mockFetch.calls.length, 1);
    assert.match(mockFetch.calls[0].url, /functions\.completeSuccess$/);
    assert.deepEqual(JSON.parse(mockFetch.calls[0].body), {
      function_execution_id: 'Fx123456',
      outputs: { greeting: 'Hello <@U77>!' },
    });
  });
});

test('function route: throwing auto-calls functions.completeError and runs boundary', async () => {
  await withFakeGlobalFetch(async (mockFetch) => {
    const alerts = [];
    const step = defineFunction({
      id: 'failing_step',
      title: 'Failing Step',
      default: async () => { throw new UserError('Missing required ticket ID'); },
    });

    const app = createApp({
      signingSecret: TEST_SIGNING_SECRET,
      botToken: 'xoxb-test',
      routes: [step],
      opsAlert: (t) => alerts.push(t),
      logger: fakeLogger(),
    });

    const res = await app.fetch(signedRequest({
      body: functionExecutedEnvelope('failing_step', {}),
    }));
    assert.equal(res.status, 200);
    await app.idle();

    const failCall = mockFetch.calls.find((c) => c.url.endsWith('functions.completeError'));
    assert.ok(failCall, 'expected functions.completeError call');
    assert.deepEqual(JSON.parse(failCall.body), {
      function_execution_id: 'Fx123456',
      error: 'Missing required ticket ID',
    });
    assert.equal(alerts.length, 0); // UserError skips opsAlert
  });
});

test('function route: returning undefined leaves execution open for async completion', async () => {
  await withFakeGlobalFetch(async (mockFetch) => {
    let seenExecId = null;
    const step = defineFunction({
      id: 'async_approval',
      title: 'Async Approval',
      default: async ({ functionExecutionId }) => {
        seenExecId = functionExecutionId;
        // Intentionally return undefined — will complete later from a button click
      },
    });

    const app = createApp({
      signingSecret: TEST_SIGNING_SECRET,
      botToken: 'xoxb-test',
      routes: [step],
      logger: fakeLogger(),
    });

    const res = await app.fetch(signedRequest({
      body: functionExecutedEnvelope('async_approval', {}),
    }));
    assert.equal(res.status, 200);
    await app.idle();

    assert.equal(seenExecId, 'Fx123456');
    assert.equal(mockFetch.calls.length, 0);
  });
});

test('function route: falls back to event.function_executed when no function route matches', async () => {
  let called = false;
  const app = createApp({
    signingSecret: TEST_SIGNING_SECRET,
    botToken: 'xoxb-test',
    routes: [route('event', 'function_executed', { default: () => { called = true; } })],
    logger: fakeLogger(),
  });

  const res = await app.fetch(signedRequest({
    body: functionExecutedEnvelope('unregistered_step', {}),
  }));
  assert.equal(res.status, 200);
  await app.idle();
  assert.equal(called, true);
});

test('function route: retries with x-slack-retry-num are dropped by default', async () => {
  let calls = 0;
  const app = createApp({
    signingSecret: TEST_SIGNING_SECRET,
    botToken: 'xoxb-test',
    routes: [defineFunction({ id: 'dedup_step', title: 'Dedup', default: () => { calls++; } })],
    logger: fakeLogger(),
  });

  const res = await app.fetch(signedRequest({
    body: functionExecutedEnvelope('dedup_step', {}),
    headers: { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' },
  }));
  assert.equal(res.status, 200);
  await app.idle();
  assert.equal(calls, 0);
});

// ── 3. Apps Script custom workflow step support ──────────────────────────────

test('createAppsScriptApp runs function routes synchronously and completes', () => {
  const fetched = [];
  const services = {
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({
        text,
        setMimeType() { return this; },
      }),
    },
    UrlFetchApp: {
      fetch: (url, init) => {
        fetched.push({ url, payload: JSON.parse(init.payload) });
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ ok: true }),
          getAllHeaders: () => ({}),
        };
      },
    },
    Utilities: { getUuid: () => 'req-gas-1', sleep: () => {} },
  };

  const app = createAppsScriptApp({
    verificationToken: 'verify-tok',
    urlKey: '0123456789abcdef',
    botToken: 'xoxb-gas',
    services,
    logger: fakeLogger(),
    routes: [
      route('function', 'gas_step', {
        default: ({ inputs }) => ({ doubled: Number(inputs.n) * 2 }),
      }),
    ],
  });

  app.doPost({
    queryString: 'key=0123456789abcdef',
    postData: {
      type: 'application/json',
      contents: JSON.stringify(functionExecutedEnvelope('gas_step', { n: 21 })),
    },
  });

  assert.equal(fetched.length, 1);
  assert.match(fetched[0].url, /functions\.completeSuccess$/);
  assert.deepEqual(fetched[0].payload, {
    function_execution_id: 'Fx123456',
    outputs: { doubled: 42 },
  });
});

// ── 4. In-app multi-step workflow builder (createWorkflow) ───────────────────

test('createWorkflow runs linear steps, persists state, and renders progress', async () => {
  const storage = memoryStorage();
  let completedState = null;

  const wf = createWorkflow({
    id: 'release',
    title: 'Release Pipeline',
    storage,
    steps: [
      { id: 'build', title: 'Build artifact', run: ({ input }) => ({ sha: `${input.branch}-abc` }) },
      { id: 'deploy', title: 'Deploy', run: ({ state }) => ({ url: `https://app/${state.sha}` }) },
    ],
    onComplete: ({ state }) => { completedState = state; },
  });

  const run = await wf.start({ branch: 'main' });
  assert.equal(run.status, 'completed');
  assert.equal(run.state.sha, 'main-abc');
  assert.equal(run.state.url, 'https://app/main-abc');
  assert.deepEqual(completedState, run.state);

  const stored = await wf.getRun(run.id);
  assert.equal(stored.status, 'completed');
  assert.equal((await wf.listRuns()).length, 1);

  const blocks = wf.renderProgress(run);
  assert.equal(blocks[0].type, 'header');
  assert.match(blocks[1].text.text, /:white_check_mark: \*Build artifact\*/);
  assert.match(blocks[1].text.text, /:white_check_mark: \*Deploy\*/);
});

test('createWorkflow pauses and resumes end-to-end via action & view routes', async () => {
  await withFakeGlobalFetch(async () => {
    const storage = memoryStorage();
    let finalRun = null;

    const wf = createWorkflow({
      id: 'approval_flow',
      title: 'Approval Flow',
      storage,
      trigger: { kind: 'command', id: '/request' },
      steps: [
        {
          id: 'approve',
          title: 'Wait for approval',
          run: () => pause({ awaiting: 'button' }),
          onResume: ({ resumeInput }) => ({ approvedBy: resumeInput.userId, decision: resumeInput.value }),
        },
        {
          id: 'details',
          title: 'Collect details',
          run: () => pause({ awaiting: 'modal' }),
          onResume: ({ resumeInput }) => ({ notes: resumeInput.values.notes_input }),
        },
        {
          id: 'finish',
          title: 'Finalize',
          run: ({ state }) => ({ summary: `${state.decision} by ${state.approvedBy}: ${state.notes}` }),
        },
      ],
      onComplete: ({ run }) => { finalRun = run; },
    });

    const app = createApp({
      signingSecret: TEST_SIGNING_SECRET,
      botToken: 'xoxb-test',
      storage,
      routes: [...wf.routes()],
      logger: fakeLogger(),
    });

    // 1. Trigger via slash command
    const cmdRes = await app.fetch(signedRequest({
      body: new URLSearchParams({
        command: '/request',
        text: 'prod deploy',
        user_id: 'U1',
        channel_id: 'C1',
        team_id: 'T1',
      }),
    }));
    assert.equal(cmdRes.status, 200);
    assert.match(await cmdRes.text(), /Started \*Approval Flow\*/);
    await app.idle();

    const runs = await wf.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'waiting');
    assert.equal(runs[0].currentStep, 'approve');
    const runId = runs[0].id;

    // 2. Resume step 1 via block_actions click
    const actionPayload = {
      type: 'block_actions',
      team: { id: 'T1' },
      user: { id: 'U_MGR' },
      channel: { id: 'C1' },
      actions: [{ action_id: wf.actionId('approve', runId), value: 'approved' }],
    };
    const actRes = await app.fetch(signedRequest({
      body: new URLSearchParams({ payload: JSON.stringify(actionPayload) }),
    }));
    assert.equal(actRes.status, 200);
    await app.idle();

    const afterAction = await wf.getRun(runId);
    assert.equal(afterAction.status, 'waiting');
    assert.equal(afterAction.currentStep, 'details');
    assert.equal(afterAction.state.approvedBy, 'U_MGR');

    // 3. Resume step 2 via view_submission modal
    const viewPayload = {
      type: 'view_submission',
      team: { id: 'T1' },
      user: { id: 'U_MGR' },
      view: {
        callback_id: wf.viewId('details', runId),
        state: {
          values: {
            notes_block: { notes_input: { type: 'plain_text_input', value: 'Ship it!' } },
          },
        },
      },
    };
    const viewRes = await app.fetch(signedRequest({
      body: new URLSearchParams({ payload: JSON.stringify(viewPayload) }),
    }));
    assert.equal(viewRes.status, 200);
    await app.idle();

    assert.ok(finalRun);
    assert.equal(finalRun.status, 'completed');
    assert.equal(finalRun.state.summary, 'approved by U_MGR: Ship it!');
  });
});

test('createWorkflow handles step errors and cancellation cleanly', async () => {
  let caughtStep = null;
  const wf = createWorkflow({
    id: 'err_flow',
    steps: [
      { id: 's1', run: () => { throw new Error('boom'); } },
    ],
    onError: ({ step }) => { caughtStep = step.id; },
  });

  const failedRun = await wf.start();
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.error, 'boom');
  assert.equal(caughtStep, 's1');

  const wf2 = createWorkflow({
    id: 'cancel_flow',
    steps: [{ id: 'wait', run: () => pause() }],
  });
  const waiting = await wf2.start();
  const cancelled = await wf2.cancel(waiting.id, 'User aborted');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.steps[0].status, 'cancelled');
});

test('extractViewValues flattens multiple Slack input block types', () => {
  const flat = extractViewValues({
    view: {
      state: {
        values: {
          b1: { title: { value: 'Bug fix' } },
          b2: { env: { selected_option: { value: 'prod' } } },
          b3: { reviewers: { selected_users: ['U1', 'U2'] } },
          b4: { tags: { selected_options: [{ value: 'a' }, { value: 'b' }] } },
        },
      },
    },
  });
  assert.deepEqual(flat, {
    title: 'Bug fix',
    env: 'prod',
    reviewers: ['U1', 'U2'],
    tags: ['a', 'b'],
  });
});

// ── 5. Manifest v2 upgrades + Manifest API CLI ───────────────────────────────

test('buildManifest emits v2 metadata, message.* scopes, shortcuts, and functions', () => {
  const fnMeta = defineFunctionManifest({
    title: 'Create Ticket',
    description: 'Opens a Jira ticket',
    inputs: {
      user_id: { type: 'user_id', title: 'Reporter', required: true },
      summary: { type: Schema.string, title: 'Summary', required: true },
    },
    outputs: {
      ticket_url: { type: Schema.string, title: 'Ticket URL', required: true },
    },
  });

  const manifest = buildManifest({
    name: 'ops-bot',
    url: 'https://bot.example.com',
    oauth: true,
    routes: [
      { parsed: { kind: 'event', id: 'message.im' } },
      { parsed: { kind: 'event', id: 'message.channels' } },
      { parsed: { kind: 'shortcut', id: 'create_ticket' } },
      { parsed: { kind: 'function', id: 'create_ticket_step' }, meta: fnMeta },
    ],
  });

  assert.deepEqual(manifest._metadata, { major_version: 2, minor_version: 1 });
  assert.ok(manifest.oauth_config.scopes.bot.includes('im:history'));
  assert.ok(manifest.oauth_config.scopes.bot.includes('channels:history'));
  assert.ok(manifest.oauth_config.scopes.bot.includes('commands'));
  assert.equal(manifest.features.shortcuts.length, 1);
  assert.equal(manifest.features.shortcuts[0].callback_id, 'create_ticket');
  assert.ok(manifest.settings.event_subscriptions.bot_events.includes('function_executed'));
  assert.equal(manifest.functions.create_ticket_step.title, 'Create Ticket');
  assert.equal(
    manifest.functions.create_ticket_step.input_parameters.properties.user_id.type,
    'slack#/types/user_id'
  );
  assert.deepEqual(manifest.functions.create_ticket_step.input_parameters.required, ['user_id', 'summary']);
});

test('scanRoutes --inspect loads exported manifest metadata from function route files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remack-inspect-'));
  try {
    await writeFile(
      join(dir, 'function.ping_step.js'),
      `export const manifest = {
        title: 'Ping Step',
        input_parameters: { properties: { target: { type: 'string', title: 'Target' } }, required: ['target'] },
        output_parameters: { properties: { ok: { type: 'boolean', title: 'OK' } } },
      };
      export default () => ({ ok: true });\n`
    );

    const routes = await scanRoutes(dir, { inspect: true });
    assert.equal(routes.length, 1);
    assert.equal(routes[0].meta.title, 'Ping Step');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI manifest:validate, manifest:push, and manifest:create call Slack Manifest API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remack-manifest-api-'));
  try {
    const manifestPath = join(dir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({ display_information: { name: 'test-bot' } }));

    // 1. manifest:validate (success)
    {
      const mockFetch = fakeFetch([{ ok: true }]);
      const { io, output } = captureIo({ fetch: mockFetch });
      const code = await runCli(
        ['manifest:validate', '--file', manifestPath, '--config-token', 'xoxe.xoxp-cfg'],
        io
      );
      assert.equal(code, 0);
      assert.match(output(), /Manifest is valid/);
      assert.match(mockFetch.calls[0].url, /apps\.manifest\.validate$/);
    }

    // 2. manifest:validate (invalid_manifest with JSON pointers)
    {
      const mockFetch = fakeFetch([{
        ok: false,
        error: 'invalid_manifest',
        errors: [{ pointer: '/settings/interactivity', message: 'Missing request_url' }],
      }]);
      const { io, output } = captureIo({ fetch: mockFetch });
      const code = await runCli(
        ['manifest:validate', '--file', manifestPath, '--config-token', 'xoxe.xoxp-cfg'],
        io
      );
      assert.equal(code, 1);
      assert.match(output(), /\/settings\/interactivity: Missing request_url/);
    }

    // 3. manifest:push
    {
      const mockFetch = fakeFetch([{ ok: true, app_id: 'A01234', permissions_updated: true }]);
      const { io, output } = captureIo({ fetch: mockFetch });
      const code = await runCli(
        ['manifest:push', '--file', manifestPath, '--app-id', 'A01234', '--config-token', 'xoxe.xoxp-cfg'],
        io
      );
      assert.equal(code, 0);
      assert.match(output(), /Updated Slack app A01234/);
      assert.match(output(), /reinstall the app/);
      assert.match(mockFetch.calls[0].url, /apps\.manifest\.update$/);
    }

    // 4. manifest:create
    {
      const mockFetch = fakeFetch([{
        ok: true,
        app_id: 'A09999',
        oauth_authorize_url: 'https://slack.com/oauth/v2/authorize?client_id=123',
        credentials: { signing_secret: 'sec123', client_id: 'cid123' },
      }]);
      const { io, output } = captureIo({ fetch: mockFetch });
      const code = await runCli(
        ['manifest:create', '--file', manifestPath, '--config-token', 'xoxe.xoxp-cfg'],
        io
      );
      assert.equal(code, 0);
      assert.match(output(), /Created Slack app A09999/);
      assert.match(output(), /Install URL:/);
      assert.match(mockFetch.calls[0].url, /apps\.manifest\.create$/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

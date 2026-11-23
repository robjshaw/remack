import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main as runCli } from '../lib/cli/index.js';
import { sanitizeServiceName, buildDeployArgs, toEnvYaml } from '../lib/cli/commands/deploy-gcp.js';
import { fakeFetch } from './fakes.js';

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

test('sanitizeServiceName normalizes directory names to valid Cloud Run service names', () => {
  assert.equal(sanitizeServiceName('My_Cool.Bot!'), 'my-cool-bot');
  assert.equal(sanitizeServiceName('---'), 'remack-bot');
});

test('buildDeployArgs defaults to --no-cpu-throttling and includes optional flags', () => {
  const args = buildDeployArgs({
    service: 'ops-bot',
    region: 'australia-southeast1',
    project: 'my-proj',
    setSecrets: 'SLACK_BOT_TOKEN=bot-token:latest',
  });
  assert.deepEqual(args, [
    'run', 'deploy', 'ops-bot',
    '--source', '.',
    '--region', 'australia-southeast1',
    '--allow-unauthenticated',
    '--no-cpu-throttling',
    '--project', 'my-proj',
    '--set-secrets', 'SLACK_BOT_TOKEN=bot-token:latest',
  ]);
});

test('toEnvYaml quotes values safely for gcloud --env-vars-file', () => {
  const yaml = toEnvYaml({ SLACK_SIGNING_SECRET: 'abc:123', SLACK_BOT_TOKEN: 'xoxb-1' });
  assert.match(yaml, /^SLACK_SIGNING_SECRET: "abc:123"\nSLACK_BOT_TOKEN: "xoxb-1"\n$/);
});

test('deploy:gcp --dry-run prints the gcloud command without executing', async () => {
  let execCalled = false;
  const { io, output } = captureIo({
    exec: async () => { execCalled = true; return { code: 0, stdout: '' }; },
  });

  const code = await runCli(
    ['deploy:gcp', '--service', 'my-bot', '--region', 'us-west1', '--project', 'demo-proj', '--dry-run'],
    io
  );

  assert.equal(code, 0);
  assert.equal(execCalled, false);
  assert.match(output(), /gcloud run deploy my-bot --source \. --region us-west1 --allow-unauthenticated --no-cpu-throttling --project demo-proj/);
});

test('deploy:gcp deploys to Cloud Run, fetches URL, and auto-pushes manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remack-gcp-test-'));
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'test-bot', scripts: { start: 'node app.js' } }));
    await writeFile(join(dir, '.env'), 'SLACK_SIGNING_SECRET=sec123\nSLACK_BOT_TOKEN=xoxb-test\n');
    await mkdir(join(dir, 'routes'));
    await writeFile(join(dir, 'routes', 'command.ping.js'), 'export default () => "pong";\n');

    const execCalls = [];
    let syncedYaml = null;
    const mockExec = async (cmd, args) => {
      execCalls.push({ cmd, args });
      if (args[1] === 'deploy') {
        const fileIdx = args.indexOf('--env-vars-file');
        if (fileIdx !== -1) {
          syncedYaml = await readFile(args[fileIdx + 1], 'utf8');
        }
        return { code: 0, stdout: '' };
      }
      if (args[1] === 'services' && args[2] === 'describe') {
        return { code: 0, stdout: 'https://test-bot-abc123.a.run.app' };
      }
      return { code: 1, stdout: '' };
    };

    const mockFetch = fakeFetch([{ ok: true, app_id: 'A0DEPLOY', permissions_updated: false }]);
    const { io, output } = captureIo({ exec: mockExec, fetch: mockFetch });

    const code = await runCli([
      'deploy:gcp',
      '--source', dir,
      '--dir', join(dir, 'routes'),
      '--service', 'test-bot',
      '--region', 'us-central1',
      '--sync-env',
      '--push-manifest',
      '--app-id', 'A0DEPLOY',
      '--config-token', 'xoxe.xoxp-cfg',
    ], io);

    assert.equal(code, 0);
    assert.equal(execCalls.length, 2);
    assert.equal(execCalls[0].cmd, 'gcloud');
    assert.ok(execCalls[0].args.includes('--no-cpu-throttling'));
    assert.match(syncedYaml, /SLACK_SIGNING_SECRET: "sec123"/);
    assert.match(syncedYaml, /SLACK_BOT_TOKEN: "xoxb-test"/);

    // Manifest push received the Cloud Run URL
    assert.equal(mockFetch.calls.length, 1);
    assert.match(mockFetch.calls[0].url, /apps\.manifest\.update$/);
    const pushedBody = JSON.parse(mockFetch.calls[0].body);
    assert.equal(pushedBody.app_id, 'A0DEPLOY');
    const pushedManifest = JSON.parse(pushedBody.manifest);
    assert.equal(
      pushedManifest.features.slash_commands[0].url,
      'https://test-bot-abc123.a.run.app/events'
    );

    assert.match(output(), /Slack Request URL: https:\/\/test-bot-abc123\.a\.run\.app\/events/);
    assert.match(output(), /Updated Slack app A0DEPLOY/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deploy:gcp reports a helpful message when gcloud is not installed', async () => {
  const { io, output } = captureIo({
    exec: async () => {
      const err = new Error('spawn gcloud ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });

  const code = await runCli(['deploy:gcp', '--service', 'my-bot'], io);
  assert.equal(code, 1);
  assert.match(output(), /gcloud CLI not found/);
});

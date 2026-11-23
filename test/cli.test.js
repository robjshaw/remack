import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../lib/cli/index.js';
import { loadConfig, profileEnv } from '../lib/cli/config.js';
import { buildManifest, scanRoutes } from '../lib/cli/commands/manifest.js';
import { parseEnvFile, resolveEnv } from '../lib/cli/commands/dev.js';

function io() {
  let output = '';
  return {
    stdout: { write: (chunk) => { output += chunk; } },
    stdin: { isTTY: false },
    get output() { return output; },
  };
}

async function withTempConfig(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'remack-cli-'));
  const previous = process.env.REMACK_CONFIG_DIR;
  process.env.REMACK_CONFIG_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.REMACK_CONFIG_DIR;
    else process.env.REMACK_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('help renders for no args (exit 1) and help (exit 0); unknown command fails', async () => {
  const empty = io();
  assert.equal(await main([], empty), 1);
  assert.match(empty.output, /USAGE/);

  const help = io();
  assert.equal(await main(['help'], help), 0);
  assert.match(help.output, /profiles:add/);

  const unknown = io();
  assert.equal(await main(['bogus'], unknown), 1);
  assert.match(unknown.output, /Unknown command 'bogus'/);
});

test('profiles: add/list/use/remove lifecycle with masked listing', async () => {
  await withTempConfig(async () => {
    const add = io();
    assert.equal(await main(['profiles:add', 'staging',
      '--bot-token', 'xoxb-staging-token-12345',
      '--signing-secret', 'sekret1234'], add), 0);
    assert.match(add.output, /Saved profile 'staging' \(active\)/);

    assert.equal(await main(['profiles:add', 'prod',
      '--bot-token', 'xoxb-prod-token-99999',
      '--signing-secret', 'sekret9999'], io()), 0);

    const list = io();
    await main(['profiles'], list);
    assert.match(list.output, /\* prod/, 'newest added becomes active by default');
    assert.match(list.output, /  staging/);
    assert.ok(!list.output.includes('xoxb-staging-token-12345'), 'tokens are masked in listings');

    const use = io();
    assert.equal(await main(['profiles:use', 'staging'], use), 0);
    assert.equal((await loadConfig()).active, 'staging');

    assert.equal(await main(['profiles:use', 'nope'], io()), 1);

    const remove = io();
    assert.equal(await main(['profiles:remove', 'staging'], remove), 0);
    const config = await loadConfig();
    assert.equal(config.profiles.staging, undefined);
    assert.equal(config.active, 'prod', 'active falls back to a remaining profile');
  });
});

test('profiles:add requires a signing secret in non-interactive mode', async () => {
  await withTempConfig(async () => {
    const out = io();
    assert.equal(await main(['profiles:add', 'x', '--bot-token', 'xoxb-1', '--no-input'], out), 1);
    assert.match(out.output, /signing secret is required/);
  });
});

test('profileEnv maps active profile to env vars without clobbering existing', async () => {
  await withTempConfig(async () => {
    await main(['profiles:add', 'p',
      '--bot-token', 'xoxb-profile',
      '--signing-secret', 'profile-secret'], io());

    const env = await profileEnv({});
    assert.equal(env.SLACK_BOT_TOKEN, 'xoxb-profile');
    assert.equal(env.SLACK_SIGNING_SECRET, 'profile-secret');

    const partial = await profileEnv({ SLACK_BOT_TOKEN: 'xoxb-already-set' });
    assert.equal(partial.SLACK_BOT_TOKEN, undefined, 'existing env wins');
    assert.equal(partial.SLACK_SIGNING_SECRET, 'profile-secret');
  });
});

test('create scaffolds a runnable token-mode project and refuses to overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remack-scaffold-'));
  const target = join(dir, 'my-bot');

  try {
    const out = io();
    assert.equal(await main(['create', target], out), 0);
    assert.match(out.output, /Created my-bot \(token mode\)/);

    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'my-bot');
    assert.match(pkg.dependencies['remack'], /^file:/);

    const routeFiles = await readdir(join(target, 'routes'));
    assert.deepEqual(routeFiles.sort(), [
      'action.demo_button.js',
      'command.modal.js',
      'command.ping.js',
      'event.app_home_opened.js',
      'view.demo.js',
    ]);

    const appJs = await readFile(join(target, 'app.js'), 'utf8');
    assert.match(appJs, /createApp\(/);
    assert.ok(!appJs.includes('oauth'), 'token mode has no oauth config');

    const again = io();
    assert.equal(await main(['create', target], again), 1);
    assert.match(again.output, /refusing to scaffold over/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('create --mode oauth wires oauth config and fileStorage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remack-scaffold-'));
  const target = join(dir, 'oauth-bot');

  try {
    assert.equal(await main(['create', target, '--mode', 'oauth'], io()), 0);
    const appJs = await readFile(join(target, 'app.js'), 'utf8');
    assert.match(appJs, /oauth: \{/);
    assert.match(appJs, /fileStorage\(/);
    assert.match(await readFile(join(target, '.env.example'), 'utf8'), /SLACK_CLIENT_ID/);

    assert.equal(await main(['create', join(dir, 'x'), '--mode', 'bogus'], io()), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('manifest derives commands, events, interactivity, and scopes from routes', async () => {
  const routes = await scanRoutes(new URL('../examples/route-bot/routes/', import.meta.url).pathname);
  const manifest = buildManifest({ routes, name: 'demo-bot', url: 'https://tunnel.example.com', oauth: false });

  assert.equal(manifest.display_information.name, 'demo-bot');

  const commands = manifest.features.slash_commands.map((c) => c.command).sort();
  assert.deepEqual(commands, ['/boom', '/modal', '/ping']);
  assert.ok(manifest.features.slash_commands.every((c) => c.url === 'https://tunnel.example.com/events'));

  assert.deepEqual(manifest.settings.event_subscriptions.bot_events, ['app_home_opened']);
  assert.equal(manifest.features.app_home.home_tab_enabled, true);
  assert.equal(manifest.settings.interactivity.is_enabled, true);
  assert.equal(manifest.settings.interactivity.request_url, 'https://tunnel.example.com/events');

  assert.deepEqual(manifest.oauth_config.scopes.bot, ['chat:write', 'commands']);
  assert.equal(manifest.oauth_config.redirect_urls, undefined);

  const withOauth = buildManifest({ routes, name: 'demo-bot', url: 'https://t.example.com', oauth: true });
  assert.deepEqual(withOauth.oauth_config.redirect_urls, ['https://t.example.com/oauth_redirect']);
});

test('manifest adds event-driven scopes', async () => {
  const routes = [
    { file: 'event.app_mention.js', parsed: { kind: 'event', id: 'app_mention' } },
    { file: 'event.message.js', parsed: { kind: 'event', id: 'message' } },
  ];
  const manifest = buildManifest({ routes, name: 'x', url: 'https://u.example.com', oauth: false });

  assert.deepEqual(manifest.oauth_config.scopes.bot, ['app_mentions:read', 'chat:write', 'im:history']);
  assert.equal(manifest.features.slash_commands, undefined);
  assert.deepEqual(manifest.settings.event_subscriptions.bot_events, ['app_mention', 'message']);
});

test('manifest command writes JSON to stdout for a routes dir', async () => {
  const out = io();
  const previousCwd = process.cwd();
  process.chdir(new URL('../examples/route-bot/', import.meta.url).pathname);
  try {
    assert.equal(await main(['manifest', '--url', 'https://real.example.com', '--name', 'route-bot'], out), 0);
  } finally {
    process.chdir(previousCwd);
  }

  const manifest = JSON.parse(out.output.split('\n# Tip')[0]);
  assert.equal(manifest.display_information.name, 'route-bot');
  assert.ok(!out.output.includes('# Tip'), 'no tunnel tip when a real url is passed');
});

test('parseEnvFile handles comments, quotes, and blank lines', () => {
  const env = parseEnvFile([
    '# comment',
    '',
    'PLAIN=value',
    'QUOTED="with spaces"',
    "SINGLE='single'",
    'EQUALS=a=b=c',
    'NOEQ',
  ].join('\n'));

  assert.deepEqual(env, {
    PLAIN: 'value',
    QUOTED: 'with spaces',
    SINGLE: 'single',
    EQUALS: 'a=b=c',
  });
});

test('resolveEnv layers process env over .env over profile', async () => {
  await withTempConfig(async () => {
    await main(['profiles:add', 'p',
      '--bot-token', 'xoxb-from-profile',
      '--signing-secret', 'secret-from-profile',
      '--alerts-channel', '#from-profile'], io());

    const dir = await mkdtemp(join(tmpdir(), 'remack-env-'));
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dir, '.env'), 'SLACK_BOT_TOKEN=xoxb-from-dotenv\n');

      const env = await resolveEnv({ cwd: dir, baseEnv: { SLACK_SIGNING_SECRET: 'from-process' } });
      assert.equal(env.SLACK_SIGNING_SECRET, 'from-process', 'process env wins');
      assert.equal(env.SLACK_BOT_TOKEN, 'xoxb-from-dotenv', '.env beats profile');
      assert.equal(env.SLACK_ALERTS_CHANNEL, '#from-profile', 'profile fills the rest');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('routes command prints the table with exports', async () => {
  const out = io();
  const previousCwd = process.cwd();
  process.chdir(new URL('../examples/route-bot/', import.meta.url).pathname);
  try {
    assert.equal(await main(['routes'], out), 0);
  } finally {
    process.chdir(previousCwd);
  }

  assert.match(out.output, /KIND\s+ID\s+EXPORTS/);
  assert.match(out.output, /command\s+\/ping\s+default/);
  assert.match(out.output, /event\s+app_home_opened\s+loader, render/);
});

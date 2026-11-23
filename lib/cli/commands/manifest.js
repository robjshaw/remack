/**
 * manifest — generate, validate, create, and push a Slack App Manifest v2
 * from the routes/ directory.
 *
 * The routes ARE the app definition, so the manifest is derived, never
 * hand-maintained: slash commands from command.* files, bot events from
 * event.* files, shortcuts from shortcut.* files, custom workflow steps
 * from function.* files, interactivity/options from action|view|shortcut|
 * options|function files, plus a right-sized starting scope set.
 *
 * By default, `remack manifest` is filename-based only (never imports user
 * code). Pass `--inspect` to also import route modules and read exported
 * `manifest` / `meta` metadata (e.g. `defineFunctionManifest(...)` inputs
 * and outputs, shortcut types, or command descriptions).
 *
 * Manifest API subcommands (require a Slack App Configuration Token,
 * `SLACK_APP_CONFIG_TOKEN` or `--config-token`):
 *   remack manifest:validate [--file manifest.json] [--url ...]
 *   remack manifest:push --app-id A0... [--file manifest.json] [--url ...]
 *   remack manifest:create [--file manifest.json] [--url ...]
 */

import { parseArgs } from 'node:util';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseRouteFilename } from '../../routes-fs.js';
import { createClient } from '../../client.js';
import { profileEnv } from '../config.js';

const EVENT_SCOPES = {
  app_mention: ['app_mentions:read'],
  message: ['im:history'],
  'message.im': ['im:history'],
  'message.channels': ['channels:history'],
  'message.groups': ['groups:history'],
  'message.mpim': ['mpim:history'],
  reaction_added: ['reactions:read'],
  reaction_removed: ['reactions:read'],
  member_joined_channel: ['channels:read'],
  channel_created: ['channels:read'],
  file_shared: ['files:read'],
  link_shared: ['links:read'],
};

export async function scanRoutes(dir, { inspect = false } = {}) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read routes directory '${dir}': ${error.message}`);
  }

  const routes = entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ file: entry.name, parsed: parseRouteFilename(entry.name) }))
    .filter(({ parsed }) => parsed !== null)
    .sort((a, b) => a.file.localeCompare(b.file));

  if (inspect) {
    for (const item of routes) {
      try {
        const mod = await import(pathToFileURL(join(dir, item.file)).href);
        item.meta = mod.manifest || mod.meta || null;
      } catch {
        item.meta = null;
      }
    }
  }

  return routes;
}

/**
 * @param {Object} options
 * @param {Array} options.routes - [{ parsed: { kind, id }, meta? }]
 * @param {string} options.url - base URL; request URLs are `${url}/events`
 * @param {string} [options.eventsUrl] - exact request URL instead (Apps
 *   Script web apps: `…/exec?key=…`)
 */
export function buildManifest({ routes, name, url, oauth, eventsUrl: exactEventsUrl }) {
  const commands = routes.filter(({ parsed }) => parsed.kind === 'command' && typeof parsed.id === 'string');
  const events = routes.filter(({ parsed }) => parsed.kind === 'event' && typeof parsed.id === 'string');
  const shortcuts = routes.filter(({ parsed }) => parsed.kind === 'shortcut' && typeof parsed.id === 'string');
  const functions = routes.filter(({ parsed }) => parsed.kind === 'function' && typeof parsed.id === 'string');
  const interactive = routes.some(({ parsed }) =>
    ['action', 'view', 'view_closed', 'shortcut', 'options', 'function'].includes(parsed.kind));
  const hasHomeTab = events.some(({ parsed }) => parsed.id === 'app_home_opened');

  const scopes = new Set(['chat:write']);
  if (commands.length || shortcuts.length) scopes.add('commands');
  for (const { parsed } of events) {
    for (const scope of EVENT_SCOPES[parsed.id] || []) scopes.add(scope);
  }

  const botEvents = new Set(events.map(({ parsed }) => parsed.id));
  if (functions.length) botEvents.add('function_executed');

  const eventsUrl = exactEventsUrl || `${url}/events`;

  const functionsBlock = {};
  for (const { parsed, meta } of functions) {
    functionsBlock[parsed.id] = meta && typeof meta === 'object'
      ? meta
      : {
          title: parsed.id,
          description: `${parsed.id} workflow step`,
          input_parameters: { properties: {} },
          output_parameters: { properties: {} },
        };
  }

  const manifest = {
    _metadata: {
      major_version: 2,
      minor_version: 1,
    },
    display_information: {
      name,
      description: `${name} — built with remack`,
    },
    features: {
      bot_user: {
        display_name: name,
        always_online: true,
      },
      ...(hasHomeTab ? { app_home: { home_tab_enabled: true, messages_tab_enabled: false } } : {}),
      ...(shortcuts.length ? {
        shortcuts: shortcuts.map(({ parsed, meta }) => ({
          name: meta?.name || parsed.id,
          type: meta?.type || 'global',
          callback_id: parsed.id,
          description: meta?.description || `${parsed.id} shortcut`,
        })),
      } : {}),
      ...(commands.length ? {
        slash_commands: commands.map(({ parsed, meta }) => ({
          command: parsed.id,
          url: eventsUrl,
          description: meta?.description || `${parsed.id} command`,
          ...(meta?.usage_hint ? { usage_hint: meta.usage_hint } : {}),
          should_escape: Boolean(meta?.should_escape),
        })),
      } : {}),
    },
    ...(functions.length ? { functions: functionsBlock } : {}),
    oauth_config: {
      scopes: { bot: [...scopes].sort() },
      ...(oauth ? { redirect_urls: [`${url}/oauth_redirect`] } : {}),
    },
    settings: {
      ...(botEvents.size ? {
        event_subscriptions: {
          request_url: eventsUrl,
          bot_events: [...botEvents].sort(),
        },
      } : {}),
      interactivity: {
        is_enabled: interactive || commands.length > 0,
        ...(interactive || commands.length ? {
          request_url: eventsUrl,
          message_menu_options_url: eventsUrl,
        } : {}),
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };

  return manifest;
}

async function resolveManifest(values, stdout) {
  if (values.file) {
    const raw = await readFile(resolve(values.file), 'utf8');
    return { manifest: JSON.parse(raw), routeCount: null };
  }
  const dir = resolve(values.dir);
  const routes = await scanRoutes(dir, { inspect: values.inspect });
  if (routes.length === 0) {
    stdout.write(`No route files found in ${dir} — nothing to build a manifest from.\n`);
    return null;
  }
  const name = values.name || basename(process.cwd());
  const manifest = buildManifest({
    routes,
    name,
    url: values.url.replace(/\/$/, ''),
    oauth: values.oauth,
  });
  return { manifest, routeCount: routes.length };
}

async function resolveConfigToken(flagValue, stdout) {
  const fromProfile = await profileEnv(process.env);
  const token = flagValue || process.env.SLACK_APP_CONFIG_TOKEN || fromProfile.SLACK_APP_CONFIG_TOKEN;
  if (!token) {
    stdout.write('Missing App Configuration Token (xoxe.xoxp-…).\n'
      + 'Pass --config-token, set SLACK_APP_CONFIG_TOKEN, or save one with: remack profiles:add <name> --config-token …\n'
      + 'Generate one at https://api.slack.com/apps → Your App Configuration Tokens.\n');
    return null;
  }
  return token;
}

async function resolveAppId(flagValue, stdout) {
  const fromProfile = await profileEnv(process.env);
  const appId = flagValue || process.env.SLACK_APP_ID || fromProfile.SLACK_APP_ID;
  if (!appId) {
    stdout.write('Missing Slack App ID (A0…).\n'
      + 'Pass --app-id, set SLACK_APP_ID, or save one with: remack profiles:add <name> --app-id …\n');
    return null;
  }
  return appId;
}

const COMMON_OPTIONS = {
  url: { type: 'string', default: 'https://YOUR-TUNNEL.example.com' },
  name: { type: 'string' },
  dir: { type: 'string', default: 'routes' },
  oauth: { type: 'boolean', default: false },
  inspect: { type: 'boolean', default: false },
  file: { type: 'string' },
  'config-token': { type: 'string' },
  'app-id': { type: 'string' },
};

export async function run(argv, { stdout }) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: COMMON_OPTIONS.url,
      name: COMMON_OPTIONS.name,
      dir: COMMON_OPTIONS.dir,
      oauth: COMMON_OPTIONS.oauth,
      inspect: COMMON_OPTIONS.inspect,
      out: { type: 'string' },
    },
  });

  const resolved = await resolveManifest(values, stdout);
  if (!resolved) return 1;

  const json = JSON.stringify(resolved.manifest, null, 2) + '\n';
  if (values.out) {
    await writeFile(resolve(values.out), json);
    stdout.write(`Wrote manifest for ${resolved.routeCount} route(s) to ${values.out}\n`);
  } else {
    stdout.write(json);
  }

  if (values.url.includes('YOUR-TUNNEL')) {
    stdout.write('\n# Tip: pass --url https://<your-tunnel> so request URLs are real.\n');
  }
  return 0;
}

function formatManifestErrors(data) {
  const errors = data?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return '';
  return errors.map((e) => `  - ${e.pointer || '/'}: ${e.message}`).join('\n') + '\n';
}

export async function validate(argv, { stdout, fetch: fetchImpl }) {
  const { values } = parseArgs({ args: argv, options: COMMON_OPTIONS });
  const token = await resolveConfigToken(values['config-token'], stdout);
  if (!token) return 1;

  const resolved = await resolveManifest(values, stdout);
  if (!resolved) return 1;

  const client = createClient({ token, fetch: fetchImpl });
  const params = { manifest: JSON.stringify(resolved.manifest) };
  if (values['app-id']) params.app_id = values['app-id'];

  try {
    await client.call('apps.manifest.validate', params);
    stdout.write('Manifest is valid.\n');
    return 0;
  } catch (error) {
    stdout.write(`Manifest validation failed: ${error.code || error.message}\n`);
    stdout.write(formatManifestErrors(error.data));
    return 1;
  }
}

export async function push(argv, { stdout, fetch: fetchImpl }) {
  const { values } = parseArgs({ args: argv, options: COMMON_OPTIONS });
  const token = await resolveConfigToken(values['config-token'], stdout);
  if (!token) return 1;
  const appId = await resolveAppId(values['app-id'], stdout);
  if (!appId) return 1;

  const resolved = await resolveManifest(values, stdout);
  if (!resolved) return 1;

  const client = createClient({ token, fetch: fetchImpl });
  try {
    const res = await client.call('apps.manifest.update', {
      app_id: appId,
      manifest: JSON.stringify(resolved.manifest),
    });
    stdout.write(`Updated Slack app ${res.app_id || appId}.\n`);
    if (res.permissions_updated) {
      stdout.write('Scopes or events changed — reinstall the app in your workspace for updates to take effect.\n');
    }
    return 0;
  } catch (error) {
    stdout.write(`Manifest update failed: ${error.code || error.message}\n`);
    stdout.write(formatManifestErrors(error.data));
    return 1;
  }
}

export async function create(argv, { stdout, fetch: fetchImpl }) {
  const { values } = parseArgs({ args: argv, options: COMMON_OPTIONS });
  const token = await resolveConfigToken(values['config-token'], stdout);
  if (!token) return 1;

  const resolved = await resolveManifest(values, stdout);
  if (!resolved) return 1;

  const client = createClient({ token, fetch: fetchImpl });
  try {
    const res = await client.call('apps.manifest.create', {
      manifest: JSON.stringify(resolved.manifest),
    });
    stdout.write(`Created Slack app ${res.app_id}\n`);
    if (res.oauth_authorize_url) {
      stdout.write(`Install URL: ${res.oauth_authorize_url}\n`);
    }
    if (res.credentials?.signing_secret) {
      stdout.write(`Signing secret: ${res.credentials.signing_secret}\n`);
    }
    if (res.credentials?.client_id) {
      stdout.write(`Client ID: ${res.credentials.client_id}\n`);
    }
    return 0;
  } catch (error) {
    stdout.write(`Manifest create failed: ${error.code || error.message}\n`);
    stdout.write(formatManifestErrors(error.data));
    return 1;
  }
}

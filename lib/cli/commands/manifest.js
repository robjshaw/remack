/**
 * manifest — generate a Slack App Manifest from the routes/ directory.
 *
 * The routes ARE the app definition, so the manifest is derived, never
 * hand-maintained: slash commands from command.* files, bot events from
 * event.* files, interactivity/options from action|view|shortcut|options
 * files, plus a right-sized starting scope set. Paste the output into
 * api.slack.com/apps → "Create from manifest" (or an existing app's
 * App Manifest page).
 *
 * Filename-based only — user route files are never imported, so this works
 * before `npm install` and can't run side effects.
 */

import { parseArgs } from 'node:util';
import { readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

import { parseRouteFilename } from '../../routes-fs.js';

const EVENT_SCOPES = {
  app_mention: ['app_mentions:read'],
  message: ['im:history'],
  reaction_added: ['reactions:read'],
  reaction_removed: ['reactions:read'],
  member_joined_channel: ['channels:read'],
  file_shared: ['files:read'],
};

export async function scanRoutes(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read routes directory '${dir}': ${error.message}`);
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ file: entry.name, parsed: parseRouteFilename(entry.name) }))
    .filter(({ parsed }) => parsed !== null)
    .sort((a, b) => a.file.localeCompare(b.file));
}

export function buildManifest({ routes, name, url, oauth }) {
  const commands = routes.filter(({ parsed }) => parsed.kind === 'command' && typeof parsed.id === 'string');
  const events = routes.filter(({ parsed }) => parsed.kind === 'event' && typeof parsed.id === 'string');
  const interactive = routes.some(({ parsed }) =>
    ['action', 'view', 'view_closed', 'shortcut', 'options'].includes(parsed.kind));
  const hasHomeTab = events.some(({ parsed }) => parsed.id === 'app_home_opened');

  const scopes = new Set(['chat:write']);
  if (commands.length) scopes.add('commands');
  for (const { parsed } of events) {
    for (const scope of EVENT_SCOPES[parsed.id] || []) scopes.add(scope);
  }

  const eventsUrl = `${url}/events`;

  const manifest = {
    display_information: {
      name,
      description: `${name} — built with slackline`,
    },
    features: {
      bot_user: {
        display_name: name,
        always_online: true,
      },
      ...(hasHomeTab ? { app_home: { home_tab_enabled: true, messages_tab_enabled: false } } : {}),
      ...(commands.length ? {
        slash_commands: commands.map(({ parsed }) => ({
          command: parsed.id,
          url: eventsUrl,
          description: `${parsed.id} command`,
          should_escape: false,
        })),
      } : {}),
    },
    oauth_config: {
      scopes: { bot: [...scopes].sort() },
      ...(oauth ? { redirect_urls: [`${url}/oauth_redirect`] } : {}),
    },
    settings: {
      ...(events.length ? {
        event_subscriptions: {
          request_url: eventsUrl,
          bot_events: [...new Set(events.map(({ parsed }) => parsed.id))].sort(),
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

export async function run(argv, { stdout }) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string', default: 'https://YOUR-TUNNEL.example.com' },
      name: { type: 'string' },
      dir: { type: 'string', default: 'routes' },
      oauth: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });

  const dir = resolve(values.dir);
  const routes = await scanRoutes(dir);

  if (routes.length === 0) {
    stdout.write(`No route files found in ${dir} — nothing to build a manifest from.\n`);
    return 1;
  }

  const name = values.name || basename(process.cwd());
  const manifest = buildManifest({ routes, name, url: values.url.replace(/\/$/, ''), oauth: values.oauth });
  const json = JSON.stringify(manifest, null, 2) + '\n';

  if (values.out) {
    await writeFile(resolve(values.out), json);
    stdout.write(`Wrote manifest for ${routes.length} route(s) to ${values.out}\n`);
  } else {
    stdout.write(json);
  }

  if (values.url.includes('YOUR-TUNNEL')) {
    stdout.write('\n# Tip: pass --url https://<your-tunnel> so request URLs are real.\n');
  }
  return 0;
}

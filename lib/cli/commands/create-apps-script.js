/**
 * create --target apps-script — scaffold a slackline bot that runs on
 * Google Apps Script: no server, no Node at runtime, deployable from any
 * Google account. See lib/apps-script.js for the trade-offs.
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

import { buildAppsScript } from './build.js';
import { buildManifest } from './manifest.js';

export const PLACEHOLDER_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec?key=YOUR_URL_KEY';

// What Code.js registers — kept in step with CODE_JS for the manifest
const SCAFFOLD_ROUTES = [
  { kind: 'command', id: '/ping' },
  { kind: 'event', id: 'app_mention' },
  { kind: 'event', id: 'app_home_opened' },
  { kind: 'action', id: 'say_hi' },
].map((parsed) => ({ parsed }));

const CODE_JS = `/**
 * A Slack bot on Google Apps Script, built with slackline.
 *
 * Secrets live in Script Properties (Project Settings → Script properties):
 *   SLACK_BOT_TOKEN           OAuth & Permissions → Bot User OAuth Token
 *   SLACK_VERIFICATION_TOKEN  Basic Information → App Credentials
 *   SLACK_URL_KEY             created for you by running setup() once
 *
 * Handlers are SYNCHRONOUS here: no async/await — client calls return their
 * results directly. Everything runs before Slack gets its ack, and Slack
 * gives up at 3 seconds (cold start included), so keep handlers quick.
 */

function routes() {
  return [
    Slackline.route('command', '/ping', {
      default: () => 'pong 🏓',
    }),

    Slackline.route('event', 'app_mention', {
      default: ({ client, channelId, payload }) => {
        client.chat.postMessage({
          channel: channelId,
          thread_ts: payload.event.ts,
          text: 'Hi from Google Apps Script 👋',
        });
      },
    }),

    Slackline.route('event', 'app_home_opened', {
      render: ({ userId }) => homeBlocks(userId, null),
    }),

    Slackline.route('action', 'say_hi', {
      default: ({ client, userId }) => {
        client.views.publish({
          user_id: userId,
          view: { type: 'home', blocks: homeBlocks(userId, new Date().toISOString()) },
        });
      },
    }),
  ];
}

function homeBlocks(userId, clickedAt) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: \`Hello <@\${userId}> — this Home tab is served by Google Apps Script.\` } },
    { type: 'actions', elements: [{ type: 'button', action_id: 'say_hi', text: { type: 'plain_text', text: 'Say hi' } }] },
    ...(clickedAt ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: \`Clicked at \${clickedAt}\` }] }] : []),
  ];
}

// ── Wiring ─────────────────────────────────────────────────────────────────

let app_;
function app() {
  return app_ || (app_ = Slackline.createAppsScriptApp({ routes: routes() }));
}

function doPost(e) {
  return app().doPost(e);
}

/** Run once from the editor: creates SLACK_URL_KEY and prints what to paste into Slack. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('SLACK_URL_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('SLACK_URL_KEY', key);
  }
  console.log('Request URL for Slack = your Web app URL (Deploy → Manage deployments, ends in /exec) + ?key=' + key);
}
`;

const APPSSCRIPT_JSON = `${JSON.stringify({
  timeZone: 'Etc/UTC',
  runtimeVersion: 'V8',
  exceptionLogging: 'STACKDRIVER',
  webapp: { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' },
}, null, 2)}\n`;

// clasp pushes only what's listed here
const CLASPIGNORE = `**/**
!appsscript.json
!Code.js
!slackline.js
`;

function readme(name) {
  return `# ${name}

A Slack bot that runs on **Google Apps Script**, built with slackline: no
server, nothing to host. \`Code.js\` is your bot; \`slackline.js\` is the
framework (generated, don't edit).

## Set up (browser only, ~10 minutes)

1. **Script project** — go to https://script.google.com → *New project*.
   - Rename \`Code.gs\` → paste in \`Code.js\` from this folder.
   - *+ → Script*, name it \`slackline\` → paste in \`slackline.js\`.
   - *Project Settings* → tick "Show appsscript.json" → replace its contents
     with \`appsscript.json\` from this folder.
2. **URL key** — select \`setup\` in the toolbar and *Run* (approve the
   permissions prompt). It saves a random \`SLACK_URL_KEY\`.
3. **Deploy** — *Deploy → New deployment → Web app*; execute as **Me**,
   access **Anyone**. Copy the Web app URL (ends in \`/exec\`).
   Your **Request URL** is that URL + \`?key=\` + the key (Run \`setup\`
   again to print it; it's also under Script Properties).
4. **Slack app** — https://api.slack.com/apps → *Create New App → From a
   manifest* → paste \`slack-manifest.json\` after replacing every
   \`${PLACEHOLDER_URL}\` with your Request URL. Install it to your workspace.
5. **Secrets** — *Project Settings → Script properties*, add:
   - \`SLACK_BOT_TOKEN\` — *OAuth & Permissions → Bot User OAuth Token*
   - \`SLACK_VERIFICATION_TOKEN\` — *Basic Information → App Credentials → Verification Token*
6. Try \`/ping\`, mention the bot in a channel, and open its Home tab.

**Changing code later:** saving doesn't update the live bot. *Deploy →
Manage deployments → ✏️ → Version: New version* — this keeps the same URL.

### Prefer the terminal?

\`\`\`
npx @google/clasp login
npx @google/clasp create --type standalone --title "${name}"
npx @google/clasp push --force      # pushes Code.js, slackline.js, appsscript.json
\`\`\`
then continue from step 2. If \`clasp create\` rewrote \`appsscript.json\`,
restore this folder's version before pushing (it needs the \`webapp\` block).
Upgrade the framework with \`slackline build:apps-script\`.

## Know the trade-offs

- **Weaker request verification.** Apps Script can't read HTTP headers, so
  Slack's request signature can't be checked. Requests are authenticated by
  Slack's (deprecated) verification token plus the secret \`?key=\` in the
  URL. Keep both secret; rotate the key if the URL leaks. There is no replay
  protection. Don't put this in front of anything sensitive.
- **Synchronous, and all of it before the ack.** No async/await, no
  \`defer()\`; Slack's 3-second window includes Apps Script's cold start. Keep
  handlers to a couple of API calls.
- **Quotas.** Apps Script limits daily URL fetches and concurrent executions
  (lower on free accounts than on Google Workspace).
- **Access policy.** Some Google Workspace admins block "Anyone" web apps.
  If you can't pick "Anyone" when deploying, use a personal Google account
  or ask your admin.
- **Logs** are under *Executions* in the script editor: one "Slack request
  handled" line per request with its outcome and ack time.
`;
}

export async function scaffoldAppsScript(dir, name, { stdout }) {
  try {
    await access(join(dir, 'Code.js'));
    stdout.write(`${dir} already has a Code.js — refusing to scaffold over it.\n`);
    return 1;
  } catch {
    // target is fresh — proceed
  }

  const manifest = buildManifest({ routes: SCAFFOLD_ROUTES, name, eventsUrl: PLACEHOLDER_URL });

  await mkdir(dir, { recursive: true });
  const files = {
    'Code.js': CODE_JS,
    'slackline.js': await buildAppsScript(),
    'appsscript.json': APPSSCRIPT_JSON,
    'slack-manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    '.claspignore': CLASPIGNORE,
    'README.md': readme(name),
  };
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(dir, file), content);
  }

  stdout.write(`Created ${name} (Google Apps Script) in ${dir}\n\n`);
  stdout.write('Next: follow README.md — paste Code.js + slackline.js into script.google.com,\n');
  stdout.write('run setup(), deploy as a web app, and create the Slack app from slack-manifest.json.\n');
  return 0;
}

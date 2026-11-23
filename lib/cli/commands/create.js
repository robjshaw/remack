/**
 * create — scaffold a new remack bot.
 *
 *   remack create my-bot                # single-token bot (simplest)
 *   remack create my-bot --mode oauth   # multi-workspace OAuth bot
 *   remack create my-bot --target apps-script   # Google Apps Script, no server
 *
 * Generates a runnable project: app.js, a routes/ directory with working
 * examples of every core pattern, env template, and a README with the exact
 * next steps (including `remack manifest` to configure the Slack app).
 */

import { parseArgs } from 'node:util';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scaffoldAppsScript } from './create-apps-script.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function packageJson(name, mode) {
  return JSON.stringify({
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      start: 'node app.js',
      dev: 'node --watch app.js',
    },
    dependencies: {
      'remack': `file:${PACKAGE_ROOT}`,
    },
    engines: { node: '>=22.0.0' },
  }, null, 2) + '\n';
}

function appJs(mode) {
  if (mode === 'oauth') {
    return `import { createApp, serve, fileStorage } from 'remack';

const app = createApp({
  routes: new URL('./routes/', import.meta.url),
  storage: fileStorage('./data/remack.json'), // installations survive restarts
  oauth: {
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
    stateSecret: process.env.SLACK_STATE_SECRET,
    scopes: ['commands', 'chat:write', 'app_mentions:read', 'im:history', 'im:write'],
  },
});

await app.ready;
const { url } = await serve({ fetch: app.fetch, port: process.env.PORT || 3000, onIdle: app.idle });
console.log(\`listening at \${url} — install at \${url}/install, Slack Request URL: \${url}/events\`);
`;
  }

  return `import { createApp, serve } from 'remack';

const app = createApp({
  routes: new URL('./routes/', import.meta.url),
});

await app.ready;
const { url } = await serve({ fetch: app.fetch, port: process.env.PORT || 3000, onIdle: app.idle });
console.log(\`listening at \${url} — Slack Request URL: \${url}/events\`);
`;
}

const ROUTE_FILES = {
  'command.ping.js': `/** /ping — the smallest possible route: the return value is the ack. */

export default async function ping() {
  return 'pong :table_tennis_paddle_and_ball:';
}
`,

  'command.modal.js': `/** /modal — opens a modal; its submission is handled by view.demo.js. */

export default async function openModal({ client, triggerId }) {
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'demo',
      title: { type: 'plain_text', text: 'Demo' },
      submit: { type: 'plain_text', text: 'Submit' },
      blocks: [
        {
          type: 'input',
          block_id: 'name_block',
          label: { type: 'plain_text', text: 'Your name' },
          element: { type: 'plain_text_input', action_id: 'name' },
        },
      ],
    },
  });
}
`,

  'view.demo.js': `/** Modal submission — validate and close, or show field errors. */

import { view } from 'remack';

export default async function demoSubmitted({ payload, defer, client, userId }) {
  const name = payload.view.state.values.name_block.name.value;

  if (!name || name.length < 2) {
    return view.errors({ name_block: 'Give me at least 2 characters.' });
  }

  defer(async () => {
    const dm = await client.conversations.open({ users: userId });
    await client.chat.postMessage({ channel: dm.channel.id, text: \`Nice to meet you, \${name}!\` });
  });
}
`,

  'action.demo_button.js': `/** Home-tab button — a returned message is delivered via response_url. */

export default async function demoButton() {
  return 'Button clicked!';
}
`,

  'event.app_home_opened.js': `/**
 * Home tab — loader fetches data, render colocates the Block Kit,
 * the framework publishes the view.
 */

export function loader({ context }) {
  return { now: new Date().toLocaleString() };
}

export function render({ data }) {
  return [
    { type: 'header', text: { type: 'plain_text', text: 'It works!' } },
    { type: 'section', text: { type: 'mrkdwn', text: \`Rendered at \${data.now}\` } },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Click me' },
        action_id: 'demo_button',
      }],
    },
  ];
}
`,
};

function envExample(mode) {
  if (mode === 'oauth') {
    return `SLACK_SIGNING_SECRET=your-signing-secret
SLACK_CLIENT_ID=your-client-id
SLACK_CLIENT_SECRET=your-client-secret
SLACK_STATE_SECRET=any-long-random-string
# PORT=3000
`;
  }
  return `SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
# PORT=3000
`;
}

function readme(name, mode) {
  return `# ${name}

A Slack bot on [remack]. Every file in \`routes/\` is one Slack
surface — the filename says what it handles.

## Get going

1. \`npm install\`
2. Create a Slack app at https://api.slack.com/apps — easiest via manifest:
   run \`remack manifest --url https://YOUR-TUNNEL\` here and paste the
   output into "Create from manifest".
3. Credentials: \`cp .env.example .env\` and fill it in — or run
   \`remack profiles:add ${name}\` once and skip .env entirely.
4. \`remack dev\` (or \`npm run dev\`), tunnel the port (e.g.
   \`ngrok http 3000\`), and make sure the app's Request URLs point at
   \`https://YOUR-TUNNEL/events\`.
5. Try \`/ping\`, \`/modal\`, and open the bot's Home tab.

## Add a surface

Drop a file in \`routes/\`: \`command.report.js\`, \`action.approve_$.js\`,
\`view.settings.js\`, \`event.app_mention.js\`… then re-run
\`remack manifest\` if it needs new commands/events/scopes.
${mode === 'oauth' ? '\nOAuth install lands at `/install`; installations persist in `./data/remack.json`.\n' : ''}`;
}

export async function run(argv, { stdout }) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      mode: { type: 'string', default: 'token' }, // token | oauth
      target: { type: 'string', default: 'node' }, // node | apps-script
      name: { type: 'string' },
    },
  });

  const target = positionals[0];
  if (!target) {
    stdout.write('Usage: remack create <directory> [--mode token|oauth] [--target node|apps-script] [--name my-bot]\n');
    return 1;
  }
  if (!['node', 'apps-script'].includes(values.target)) {
    stdout.write(`Unknown --target '${values.target}' (expected node or apps-script)\n`);
    return 1;
  }
  if (values.target === 'apps-script') {
    if (values.mode !== 'token') {
      stdout.write('Apps Script bots are single-workspace: --mode oauth is not supported with --target apps-script\n');
      return 1;
    }
    const dir = resolve(target);
    return scaffoldAppsScript(dir, values.name || basename(dir), { stdout });
  }
  if (!['token', 'oauth'].includes(values.mode)) {
    stdout.write(`Unknown --mode '${values.mode}' (expected token or oauth)\n`);
    return 1;
  }

  const dir = resolve(target);
  const name = values.name || basename(dir);

  try {
    await access(join(dir, 'package.json'));
    stdout.write(`${dir} already has a package.json — refusing to scaffold over it.\n`);
    return 1;
  } catch {
    // target is fresh — proceed
  }

  await mkdir(join(dir, 'routes'), { recursive: true });

  const files = {
    'package.json': packageJson(name, values.mode),
    'app.js': appJs(values.mode),
    '.env.example': envExample(values.mode),
    '.gitignore': 'node_modules/\n.env\ndata/\n',
    'README.md': readme(name, values.mode),
  };
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(dir, file), content);
  }
  for (const [file, content] of Object.entries(ROUTE_FILES)) {
    await writeFile(join(dir, 'routes', file), content);
  }

  stdout.write(`Created ${name} (${values.mode} mode) in ${dir}\n\nNext steps:\n`);
  stdout.write(`  cd ${target}\n  npm install\n`);
  stdout.write(`  remack manifest --url https://YOUR-TUNNEL   # paste into api.slack.com "from manifest"\n`);
  stdout.write(values.mode === 'oauth'
    ? `  # put client credentials in .env (see .env.example), then:\n`
    : `  remack profiles:add ${name}    # or: cp .env.example .env\n`);
  stdout.write(`  remack dev\n`);
  return 0;
}

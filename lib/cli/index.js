/**
 * remack CLI — topic:command dispatch, twilio-cli style.
 *
 *   remack create <dir>        scaffold a new bot
 *   remack dev [entry]         run locally (watch + profile credentials)
 *   remack routes              show the route table
 *   remack manifest            generate a Slack App Manifest from routes/
 *   remack build:apps-script   bundle the Google Apps Script adapter
 *   remack profiles            list credential profiles
 *   remack profiles:add <name> save credentials (becomes active)
 *   remack profiles:use <name> switch active profile
 *   remack profiles:remove <name>
 */

import * as create from './commands/create.js';
import * as dev from './commands/dev.js';
import * as routes from './commands/routes.js';
import * as manifest from './commands/manifest.js';
import * as profiles from './commands/profiles.js';
import * as build from './commands/build.js';
import * as deployGcp from './commands/deploy-gcp.js';

const HELP = `remack — zero-dependency Slack bot framework CLI

USAGE
  remack <command> [args]

COMMANDS
  create <dir>            Scaffold a new bot (--mode token|oauth, --target node|apps-script, --name)
  dev [entry]             Run locally with watch + profile credentials (--no-watch)
  routes                  Show this bot's route table (--dir routes)
  manifest                Slack App Manifest v2 from routes/ (--url, --name, --oauth, --inspect, --out)
  manifest:validate       Validate manifest against Slack's API (--config-token, --file)
  manifest:push           Update an existing Slack app's manifest (--app-id, --config-token)
  manifest:create         Create a new Slack app from the manifest (--config-token)
  deploy:gcp              Deploy to Google Cloud Run (--region, --project, --push-manifest)
  build:apps-script       Bundle remack for Google Apps Script (--out remack.js)
  profiles                List credential profiles
  profiles:add <name>     Save credentials (--bot-token, --signing-secret, ...)
  profiles:use <name>     Switch the active profile
  profiles:remove <name>  Delete a profile
  help                    Show this help

GET GOING
  remack create my-bot && cd my-bot && npm install
  remack manifest --url https://YOUR-TUNNEL   # paste into api.slack.com
  remack profiles:add my-bot                  # or cp .env.example .env
  remack dev
`;

export async function main(argv, io = { stdout: process.stdout, stdin: process.stdin }) {
  const [command, ...rest] = argv;

  switch (command) {
    case 'create': return create.run(rest, io);
    case 'dev': return dev.run(rest, io);
    case 'routes': return routes.run(rest, io);
    case 'manifest': return manifest.run(rest, io);
    case 'manifest:validate': return manifest.validate(rest, io);
    case 'manifest:push': return manifest.push(rest, io);
    case 'manifest:create': return manifest.create(rest, io);
    case 'deploy:gcp': return deployGcp.run(rest, io);
    case 'build:apps-script': return build.run(rest, io);
    case 'profiles':
    case 'profiles:list': return profiles.list(io);
    case 'profiles:add': return profiles.add(rest, io);
    case 'profiles:use': return profiles.use(rest, io);
    case 'profiles:remove': return profiles.remove(rest, io);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.stdout.write(HELP);
      return command === undefined ? 1 : 0;
    default:
      io.stdout.write(`Unknown command '${command}'. Run: remack help\n`);
      return 1;
  }
}

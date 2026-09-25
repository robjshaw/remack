/**
 * slackline CLI — topic:command dispatch, twilio-cli style.
 *
 *   slackline create <dir>        scaffold a new bot
 *   slackline dev [entry]         run locally (watch + profile credentials)
 *   slackline routes              show the route table
 *   slackline manifest            generate a Slack App Manifest from routes/
 *   slackline build:apps-script   bundle the Google Apps Script adapter
 *   slackline profiles            list credential profiles
 *   slackline profiles:add <name> save credentials (becomes active)
 *   slackline profiles:use <name> switch active profile
 *   slackline profiles:remove <name>
 */

import * as create from './commands/create.js';
import * as dev from './commands/dev.js';
import * as routes from './commands/routes.js';
import * as manifest from './commands/manifest.js';
import * as profiles from './commands/profiles.js';
import * as build from './commands/build.js';

const HELP = `slackline — zero-dependency Slack bot framework CLI

USAGE
  slackline <command> [args]

COMMANDS
  create <dir>            Scaffold a new bot (--mode token|oauth, --target node|apps-script, --name)
  dev [entry]             Run locally with watch + profile credentials (--no-watch)
  routes                  Show this bot's route table (--dir routes)
  manifest                Slack App Manifest from routes/ (--url, --name, --oauth, --out)
  build:apps-script       Bundle slackline for Google Apps Script (--out slackline.js)
  profiles                List credential profiles
  profiles:add <name>     Save credentials (--bot-token, --signing-secret, ...)
  profiles:use <name>     Switch the active profile
  profiles:remove <name>  Delete a profile
  help                    Show this help

GET GOING
  slackline create my-bot && cd my-bot && npm install
  slackline manifest --url https://YOUR-TUNNEL   # paste into api.slack.com
  slackline profiles:add my-bot                  # or cp .env.example .env
  slackline dev
`;

export async function main(argv, io = { stdout: process.stdout, stdin: process.stdin }) {
  const [command, ...rest] = argv;

  switch (command) {
    case 'create': return create.run(rest, io);
    case 'dev': return dev.run(rest, io);
    case 'routes': return routes.run(rest, io);
    case 'manifest': return manifest.run(rest, io);
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
      io.stdout.write(`Unknown command '${command}'. Run: slackline help\n`);
      return 1;
  }
}

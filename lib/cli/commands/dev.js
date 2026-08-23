/**
 * dev — run the bot locally with watch mode and profile credentials.
 *
 * Env resolution (first hit wins per variable):
 *   1. the process env you launched with
 *   2. ./.env (parsed here — no dotenv dependency)
 *   3. the active slackline profile (slackline profiles:add)
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { profileEnv, getActiveProfile } from '../config.js';

/** Minimal .env parser: KEY=value lines, # comments, optional quotes. */
export function parseEnvFile(text) {
  const env = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
  }
  return env;
}

export async function resolveEnv({ cwd = process.cwd(), baseEnv = process.env } = {}) {
  const env = { ...baseEnv };

  try {
    const fileEnv = parseEnvFile(await readFile(resolve(cwd, '.env'), 'utf8'));
    for (const [key, value] of Object.entries(fileEnv)) {
      if (env[key] === undefined) env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  Object.assign(env, await profileEnv(env));
  return env;
}

export async function run(argv, { stdout }) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      watch: { type: 'boolean', default: true },
      'no-watch': { type: 'boolean', default: false },
    },
  });

  const entry = positionals[0] || 'app.js';
  const env = await resolveEnv();

  const profile = await getActiveProfile();
  const missing = ['SLACK_SIGNING_SECRET'].filter((key) => !env[key]);
  if (missing.length) {
    stdout.write(`Missing ${missing.join(', ')}.\n`);
    stdout.write(profile
      ? `Active profile '${profile.name}' doesn't provide it — edit with: slackline profiles:add ${profile.name}\n`
      : 'Set it in .env, or run: slackline profiles:add <name>\n');
    return 1;
  }

  const source = env.SLACK_BOT_TOKEN
    ? (process.env.SLACK_BOT_TOKEN ? 'env' : profile && !process.env.SLACK_BOT_TOKEN ? `profile/.env` : '.env')
    : 'oauth mode';
  stdout.write(`slackline dev: ${entry} (credentials: ${source}${profile ? `, profile '${profile.name}'` : ''})\n`);

  const nodeArgs = values['no-watch'] || !values.watch ? [entry] : ['--watch', entry];
  const child = spawn(process.execPath, nodeArgs, { env, stdio: 'inherit' });

  return new Promise((resolvePromise) => {
    child.on('exit', (code) => resolvePromise(code ?? 0));
  });
}

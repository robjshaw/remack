/**
 * profiles — twilio-style credential management.
 *
 *   slackline profiles              list profiles (active marked)
 *   slackline profiles:add <name>   prompt for credentials (or pass flags)
 *   slackline profiles:use <name>   make a profile active
 *   slackline profiles:remove <name>
 */

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';

import { loadConfig, saveConfig, PROFILE_ENV_MAP, configDir } from '../config.js';

function mask(value) {
  if (!value) return '—';
  return value.length > 8 ? `${value.slice(0, 5)}…${value.slice(-3)}` : '••••';
}

export async function list({ stdout }) {
  const config = await loadConfig();
  const names = Object.keys(config.profiles);

  if (names.length === 0) {
    stdout.write(`No profiles yet. Create one with: slackline profiles:add <name>\n(config: ${configDir()})\n`);
    return 0;
  }

  for (const name of names) {
    const profile = config.profiles[name];
    const marker = name === config.active ? '*' : ' ';
    stdout.write(`${marker} ${name}  token=${mask(profile.botToken)}  signing=${mask(profile.signingSecret)}${profile.clientId ? '  oauth' : ''}\n`);
  }
  return 0;
}

export async function add(argv, { stdout, stdin }) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'bot-token': { type: 'string' },
      'signing-secret': { type: 'string' },
      'client-id': { type: 'string' },
      'client-secret': { type: 'string' },
      'state-secret': { type: 'string' },
      'alerts-channel': { type: 'string' },
      use: { type: 'boolean', default: true },
      'no-input': { type: 'boolean', default: false },
    },
  });

  const name = positionals[0];
  if (!name) {
    stdout.write('Usage: slackline profiles:add <name> [--bot-token xoxb-…] [--signing-secret …]\n');
    return 1;
  }

  const profile = {
    botToken: values['bot-token'],
    signingSecret: values['signing-secret'],
    clientId: values['client-id'],
    clientSecret: values['client-secret'],
    stateSecret: values['state-secret'],
    alertsChannel: values['alerts-channel'],
  };

  if (!values['no-input'] && (!profile.botToken || !profile.signingSecret) && stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      profile.botToken ||= (await rl.question('Bot token (xoxb-…, blank for OAuth-only): ')).trim() || undefined;
      profile.signingSecret ||= (await rl.question('Signing secret: ')).trim() || undefined;
    } finally {
      rl.close();
    }
  }

  if (!profile.signingSecret) {
    stdout.write('A signing secret is required (find it under Basic Information on api.slack.com/apps).\n');
    return 1;
  }

  for (const key of Object.keys(profile)) {
    if (profile[key] === undefined) delete profile[key];
  }

  const config = await loadConfig();
  config.profiles[name] = profile;
  if (values.use || !config.active) config.active = name;
  await saveConfig(config);

  stdout.write(`Saved profile '${name}'${config.active === name ? ' (active)' : ''} → ${configDir()}\n`);
  return 0;
}

export async function use(argv, { stdout }) {
  const name = argv[0];
  const config = await loadConfig();

  if (!name || !config.profiles[name]) {
    stdout.write(`Unknown profile '${name || ''}'. Available: ${Object.keys(config.profiles).join(', ') || '(none)'}\n`);
    return 1;
  }

  config.active = name;
  await saveConfig(config);
  stdout.write(`Active profile: ${name}\n`);
  return 0;
}

export async function remove(argv, { stdout }) {
  const name = argv[0];
  const config = await loadConfig();

  if (!name || !config.profiles[name]) {
    stdout.write(`Unknown profile '${name || ''}'.\n`);
    return 1;
  }

  delete config.profiles[name];
  if (config.active === name) {
    config.active = Object.keys(config.profiles)[0] || null;
  }
  await saveConfig(config);
  stdout.write(`Removed profile '${name}'.${config.active ? ` Active: ${config.active}` : ''}\n`);
  return 0;
}

export const ENV_FIELDS = PROFILE_ENV_MAP;

/**
 * CLI config + credential profiles (twilio-cli style).
 *
 * Profiles hold Slack credentials so you can switch bots/workspaces without
 * editing .env files: `remack profiles:add staging`, then `remack dev`
 * injects the active profile's env. Stored at
 * $XDG_CONFIG_HOME/remack/config.json (~/.config/remack/config.json),
 * overridable with REMACK_CONFIG_DIR (tests).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function configDir() {
  if (process.env.REMACK_CONFIG_DIR) return process.env.REMACK_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'remack');
}

function configPath() {
  return join(configDir(), 'config.json');
}

export async function loadConfig() {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { active: null, profiles: {} };
    throw error;
  }
}

export async function saveConfig(config) {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

/** Credential fields a profile may hold, mapped to the env vars dev injects. */
export const PROFILE_ENV_MAP = {
  botToken: 'SLACK_BOT_TOKEN',
  signingSecret: 'SLACK_SIGNING_SECRET',
  clientId: 'SLACK_CLIENT_ID',
  clientSecret: 'SLACK_CLIENT_SECRET',
  stateSecret: 'SLACK_STATE_SECRET',
  alertsChannel: 'SLACK_ALERTS_CHANNEL',
  configToken: 'SLACK_APP_CONFIG_TOKEN',
  appId: 'SLACK_APP_ID',
};

export async function getActiveProfile() {
  const config = await loadConfig();
  if (!config.active) return null;
  const profile = config.profiles[config.active];
  return profile ? { name: config.active, ...profile } : null;
}

/** Env object from the active profile — only vars not already set win. */
export async function profileEnv(existingEnv = process.env) {
  const profile = await getActiveProfile();
  if (!profile) return {};

  const env = {};
  for (const [field, envVar] of Object.entries(PROFILE_ENV_MAP)) {
    if (profile[field] && !existingEnv[envVar]) {
      env[envVar] = profile[field];
    }
  }
  return env;
}

/**
 * deploy:gcp — one-command Google Cloud Run deploy for a remack bot.
 *
 * Uses `gcloud run deploy --source .` (Cloud Run's Node.js buildpack — no
 * Dockerfile needed as long as package.json has `"start": "node app.js"`
 * and listens on `process.env.PORT`).
 *
 * Defaults to `--no-cpu-throttling` so post-ack work (`defer()` and
 * `event.*` / `function.*` continuations) is never frozen after the 200
 * ack is sent. After deploy, fetches the stable `https://…run.app` URL and
 * optionally pushes it straight into your Slack App Manifest via
 * `remack manifest:push`.
 */

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { parseEnvFile } from './dev.js';
import { profileEnv } from '../config.js';
import * as manifestCmd from './manifest.js';

const SYNC_ENV_KEYS = [
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_TOKEN',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_STATE_SECRET',
  'SLACK_ALERTS_CHANNEL',
];

/** Sanitize a directory name into a valid Cloud Run service name. */
export function sanitizeServiceName(raw) {
  const cleaned = String(raw || 'remack-bot')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return cleaned || 'remack-bot';
}

/** Serialize flat key/value pairs as a YAML file for `gcloud --env-vars-file`. */
export function toEnvYaml(env) {
  return Object.entries(env)
    .map(([k, v]) => `${k}: ${JSON.stringify(String(v))}`)
    .join('\n') + '\n';
}

function defaultExec(cmd, args, { capture = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('exit', (code) => {
      resolvePromise({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function loadSyncEnv(cwd) {
  let fromDotenv = {};
  try {
    fromDotenv = parseEnvFile(await readFile(join(cwd, '.env'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const mergedBase = { ...fromDotenv, ...process.env };
  const fromProfile = await profileEnv(mergedBase);
  const combined = { ...fromProfile, ...fromDotenv, ...process.env };

  const out = {};
  for (const key of SYNC_ENV_KEYS) {
    if (combined[key]) out[key] = combined[key];
  }
  return out;
}

export function buildDeployArgs({
  service,
  region,
  project,
  source = '.',
  cpuThrottling = false,
  setSecrets,
  envVarsFile,
}) {
  const args = [
    'run', 'deploy', service,
    '--source', source,
    '--region', region,
    '--allow-unauthenticated',
    cpuThrottling ? '--cpu-throttling' : '--no-cpu-throttling',
  ];
  if (project) args.push('--project', project);
  if (setSecrets) args.push('--set-secrets', setSecrets);
  if (envVarsFile) args.push('--env-vars-file', envVarsFile);
  return args;
}

export async function run(argv, io = { stdout: process.stdout, stdin: process.stdin }) {
  const { stdout, exec = defaultExec } = io;
  const { values } = parseArgs({
    args: argv,
    options: {
      service: { type: 'string' },
      region: { type: 'string' },
      project: { type: 'string' },
      source: { type: 'string', default: '.' },
      dir: { type: 'string', default: 'routes' },
      name: { type: 'string' },
      oauth: { type: 'boolean', default: false },
      inspect: { type: 'boolean', default: false },
      'push-manifest': { type: 'boolean', default: false },
      'app-id': { type: 'string' },
      'config-token': { type: 'string' },
      'set-secrets': { type: 'string' },
      'sync-env': { type: 'boolean', default: false },
      'cpu-throttling': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const cwd = resolve(values.source);
  const service = sanitizeServiceName(values.service || basename(cwd));
  const region = values.region || process.env.GCP_REGION || process.env.GOOGLE_CLOUD_REGION || 'us-central1';
  const project = values.project || process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const shouldPush = values['push-manifest'] || Boolean(values['app-id']);

  // Check package.json has a start script (Cloud Run buildpack requirement)
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    if (!pkg.scripts?.start) {
      stdout.write('Warning: package.json has no "start" script — Cloud Run\'s Node.js buildpack runs `npm start`.\n');
    }
  } catch { /* non-fatal: user may have a Dockerfile */ }

  let tmpDir = null;
  let envVarsFile;
  try {
    if (values['sync-env']) {
      const env = await loadSyncEnv(cwd);
      const keys = Object.keys(env);
      if (keys.length === 0) {
        stdout.write('Warning: --sync-env set, but no SLACK_* variables were found in env, .env, or active profile.\n');
      } else if (values['dry-run']) {
        envVarsFile = '<temp-env.yaml>';
        stdout.write(`Would sync env vars: ${keys.join(', ')}\n`);
      } else {
        tmpDir = await mkdtemp(join(tmpdir(), 'remack-gcp-'));
        envVarsFile = join(tmpDir, 'env.yaml');
        await writeFile(envVarsFile, toEnvYaml(env), { mode: 0o600 });
        stdout.write(`Syncing ${keys.length} SLACK_* env var(s) via temporary --env-vars-file\n`);
      }
    }

    const deployArgs = buildDeployArgs({
      service,
      region,
      project,
      source: values.source,
      cpuThrottling: values['cpu-throttling'],
      setSecrets: values['set-secrets'],
      envVarsFile,
    });

    if (values['dry-run']) {
      stdout.write(`gcloud ${deployArgs.join(' ')}\n`);
      if (shouldPush) {
        stdout.write('Then: remack manifest:push --url <deployed-service-url>\n');
      }
      return 0;
    }

    stdout.write(`Deploying '${service}' to Cloud Run (${region}${project ? `, project ${project}` : ''})…\n`);
    let deployRes;
    try {
      deployRes = await exec('gcloud', deployArgs, { capture: false });
    } catch (error) {
      if (error.code === 'ENOENT') {
        stdout.write('gcloud CLI not found. Install it from https://cloud.google.com/sdk/docs/install and run `gcloud auth login`.\n');
        return 1;
      }
      throw error;
    }

    if (deployRes.code !== 0) {
      stdout.write(`Cloud Run deploy failed (exit ${deployRes.code}).\n`);
      return deployRes.code;
    }

    const describeArgs = [
      'run', 'services', 'describe', service,
      '--region', region,
      '--format=value(status.url)',
    ];
    if (project) describeArgs.push('--project', project);

    const descRes = await exec('gcloud', describeArgs, { capture: true });
    if (descRes.code !== 0 || !descRes.stdout) {
      stdout.write('Deploy succeeded, but could not read the service URL from gcloud.\n');
      return 1;
    }

    const serviceUrl = descRes.stdout.replace(/\/$/, '');
    stdout.write(`\nDeployed:          ${serviceUrl}\n`);
    stdout.write(`Slack Request URL: ${serviceUrl}/events\n`);
    if (values.oauth) {
      stdout.write(`OAuth Redirect:    ${serviceUrl}/oauth_redirect\n`);
    }

    if (shouldPush) {
      const pushArgv = ['--url', serviceUrl, '--dir', values.dir];
      if (values.name) pushArgv.push('--name', values.name);
      if (values.oauth) pushArgv.push('--oauth');
      if (values.inspect) pushArgv.push('--inspect');
      if (values['app-id']) pushArgv.push('--app-id', values['app-id']);
      if (values['config-token']) pushArgv.push('--config-token', values['config-token']);
      stdout.write('\nUpdating Slack App Manifest…\n');
      return manifestCmd.push(pushArgv, io);
    }

    stdout.write(`\nNext: update Slack with:\n  remack manifest:push --url ${serviceUrl} --app-id <A0…>\n`);
    return 0;
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Minimal remack bot in route-module style.
 *
 * Every Slack surface is one file in routes/ — see the filenames for the
 * convention. Run with SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET set, tunnel
 * the port, and point your Slack app's Request URL at
 * https://<tunnel>/events (commands, interactivity, and events all share it).
 */

import { createApp, serve } from '../../lib/index.js';
import { createOpsAlert } from '../../ext/ops-alert.js';

const { sendOpsAlert } = createOpsAlert({});

const app = createApp({
  routes: new URL('./routes/', import.meta.url),
  opsAlert: process.env.SLACK_ALERTS_CHANNEL ? sendOpsAlert : undefined,
  context: {
    startedAt: new Date(),
  },
});

await app.ready;
const { url } = await serve({
  fetch: app.fetch,
  port: process.env.PORT || 3000,
  onIdle: app.idle,
});

console.log(`remack example bot listening at ${url} — Slack Request URL: ${url}/events`);

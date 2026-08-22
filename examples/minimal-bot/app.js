'use strict';

/**
 * Minimal boltkit bot.
 *
 * Demonstrates: single-token bootstrap, a handler module, plan-block
 * progress UI, and central error handling (try /boom).
 *
 * Run: copy .env.example to .env, fill in tokens, then `npm run example`.
 * Point your Slack app's Request URL at https://<tunnel>/slack/events.
 */

require('dotenv').config();

const {
  createSlackApp,
  createErrorHandler,
  createOpsAlert,
  SlackUserError,
  buildPlanBlock,
  createSteps,
} = require('../../lib');

const pingModule = {
  name: 'ping',
  register(r) {
    r.command('/ping', async ({ ack }) => {
      await ack('pong :table_tennis_paddle_and_ball:');
    });

    // Deliberately throws — shows the central error handler in action
    r.command('/boom', async ({ ack, command }) => {
      await ack();
      if (command.text === 'user') {
        throw new SlackUserError('You asked for a friendly error, here it is.');
      }
      throw new Error('Deliberate unexpected failure');
    });

    r.action('demo_button', async ({ ack, respond }) => {
      await ack();
      await respond({ text: 'Button clicked!', replace_original: false });
    });

    r.event('app_home_opened', async ({ event, client }) => {
      await client.views.publish({
        user_id: event.user,
        view: {
          type: 'home',
          blocks: [
            ...buildPlanBlock({
              title: 'boltkit demo',
              steps: createSteps(['Install boltkit', 'Write a module', 'Ship your bot']).map(
                (step, index) => ({ ...step, status: index === 0 ? 'complete' : 'pending' })
              ),
            }),
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Click me' },
                  action_id: 'demo_button',
                },
              ],
            },
          ],
        },
      });
    });
  },
};

function main() {
  const { sendOpsAlert } = createOpsAlert({});

  const errorHandler = createErrorHandler({
    opsAlert: process.env.SLACK_ALERTS_CHANNEL ? sendOpsAlert : undefined,
  });

  const { app, mode } = createSlackApp({
    errorHandler,
    modules: [pingModule],
  });

  const port = process.env.PORT || 3000;
  app.start(port).then(() => {
    console.log(`boltkit example bot running on port ${port} (${mode} mode)`);
  });
}

main();

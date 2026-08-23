/**
 * Home tab — the Remix idea where it fits Slack best: loader fetches data,
 * render colocates the Block Kit, the framework publishes the view.
 */

import { buildPlanBlock, createSteps } from '../../../ext/plan-block.js';

export function loader({ context }) {
  return {
    startedAt: context.startedAt,
    steps: createSteps(['Install slackline', 'Write a route', 'Ship your bot'])
      .map((step, index) => ({ ...step, status: index === 0 ? 'complete' : 'pending' })),
  };
}

export function render({ data }) {
  return [
    ...buildPlanBlock({ title: 'slackline demo', steps: data.steps }),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Bot running since ${data.startedAt.toISOString()}` }],
    },
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

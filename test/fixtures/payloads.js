/** Realistic Slack payload fixtures, one per wire shape. Reused across suites. */

export const slashCommandForm = new URLSearchParams({
  token: 'deprecated-verification-token',
  team_id: 'T111',
  team_domain: 'acme',
  channel_id: 'C222',
  channel_name: 'general',
  user_id: 'U333',
  user_name: 'rob',
  command: '/report',
  text: 'weekly',
  response_url: 'https://hooks.slack.com/commands/T111/1/abc',
  trigger_id: '444.555.666',
  api_app_id: 'A777',
  is_enterprise_install: 'false',
});

export const blockActions = {
  type: 'block_actions',
  team: { id: 'T111', domain: 'acme' },
  user: { id: 'U333', username: 'rob', team_id: 'T111' },
  api_app_id: 'A777',
  container: { type: 'message', message_ts: '123.456', channel_id: 'C222', is_ephemeral: false },
  trigger_id: '444.555.666',
  channel: { id: 'C222', name: 'general' },
  response_url: 'https://hooks.slack.com/actions/T111/1/abc',
  actions: [
    { action_id: 'open_settings', block_id: 'b1', type: 'button', value: 'go', action_ts: '123.456' },
    { action_id: 'secondary', block_id: 'b1', type: 'button', action_ts: '123.456' },
  ],
};

export const viewSubmission = {
  type: 'view_submission',
  team: { id: 'T111', domain: 'acme' },
  user: { id: 'U333', username: 'rob', team_id: 'T111' },
  api_app_id: 'A777',
  trigger_id: '444.555.777',
  view: {
    id: 'V888',
    callback_id: 'settings',
    type: 'modal',
    private_metadata: '{"step":1}',
    state: { values: { b1: { field: { type: 'plain_text_input', value: 'hello' } } } },
  },
  response_urls: [],
  is_enterprise_install: false,
};

export const viewClosed = {
  type: 'view_closed',
  team: { id: 'T111', domain: 'acme' },
  user: { id: 'U333', team_id: 'T111' },
  view: { id: 'V888', callback_id: 'settings', type: 'modal' },
  is_cleared: false,
};

export const globalShortcut = {
  type: 'shortcut',
  token: 'x',
  action_ts: '123.456',
  team: { id: 'T111', domain: 'acme' },
  user: { id: 'U333', username: 'rob', team_id: 'T111' },
  callback_id: 'new_task',
  trigger_id: '444.555.888',
};

export const messageAction = {
  type: 'message_action',
  callback_id: 'summarize_message',
  trigger_id: '444.555.999',
  team: { id: 'T111', domain: 'acme' },
  user: { id: 'U333', name: 'rob' },
  channel: { id: 'C222', name: 'general' },
  message: { type: 'message', user: 'U444', ts: '123.456', text: 'summarize me' },
  response_url: 'https://hooks.slack.com/app/T111/1/abc',
};

export const blockSuggestion = {
  type: 'block_suggestion',
  team: { id: 'T111', domain: 'acme' },
  user: { id: 'U333', team_id: 'T111' },
  container: { type: 'view', view_id: 'V888' },
  api_app_id: 'A777',
  action_id: 'project_picker',
  block_id: 'b2',
  value: 'acm',
};

export const eventCallback = {
  token: 'x',
  team_id: 'T111',
  api_app_id: 'A777',
  type: 'event_callback',
  event_id: 'Ev999',
  event_time: 1700000000,
  is_enterprise_install: false,
  event: {
    type: 'app_mention',
    user: 'U333',
    text: '<@UBOT> hello',
    ts: '123.456',
    channel: 'C222',
    event_ts: '123.456',
  },
};

export const homeOpenedEvent = {
  token: 'x',
  team_id: 'T111',
  api_app_id: 'A777',
  type: 'event_callback',
  event_id: 'Ev1000',
  event_time: 1700000001,
  event: { type: 'app_home_opened', user: 'U333', channel: 'D555', tab: 'home' },
};

export const urlVerification = {
  token: 'x',
  challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P',
  type: 'url_verification',
};

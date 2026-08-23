/**
 * Slack payload parsing.
 *
 * Slack delivers three wire shapes to one endpoint:
 *  1. Slash commands — application/x-www-form-urlencoded, flat fields
 *  2. Interactivity — form-encoded with a single `payload` field of JSON
 *     (block_actions, view_submission, view_closed, shortcut, message_action,
 *     block_suggestion)
 *  3. Events API — application/json envelope (event_callback,
 *     url_verification, app_rate_limited)
 *
 * All are normalized into one SlackRequest so route handlers never care
 * which wire shape delivered them.
 *
 * @typedef {Object} SlackRequest
 * @property {'command'|'action'|'view'|'view_closed'|'shortcut'|'options'|'event'} kind
 * @property {string} id - '/command' | action_id | callback_id | event type
 * @property {Object} payload - The full parsed body, nothing hidden
 * @property {string|null} teamId
 * @property {string|null} enterpriseId
 * @property {boolean} isEnterpriseInstall
 * @property {string|null} userId
 * @property {string|null} channelId
 * @property {string|null} triggerId
 * @property {string|null} responseUrl
 * @property {{num: number, reason: string}|null} retry - Events API retry headers
 */

const INTERACTIVITY_KINDS = {
  block_actions: 'action',
  view_submission: 'view',
  view_closed: 'view_closed',
  shortcut: 'shortcut',
  message_action: 'shortcut',
  block_suggestion: 'options',
  interactive_message: 'action', // legacy attachments
};

function toBool(value) {
  return value === true || value === 'true';
}

function normalizeInteractivity(payload) {
  const type = payload.type;
  const kind = INTERACTIVITY_KINDS[type];
  if (!kind) {
    throw new ParseError(`Unknown interactivity payload type: ${type}`);
  }

  let id;
  if (kind === 'action') {
    id = payload.actions?.[0]?.action_id || payload.callback_id || '';
  } else if (kind === 'options') {
    id = payload.action_id || '';
  } else {
    // view / view_closed / shortcut / message_action
    id = payload.view?.callback_id || payload.callback_id || '';
  }

  return {
    kind,
    id,
    payload,
    teamId: payload.team?.id || payload.user?.team_id || null,
    enterpriseId: payload.enterprise?.id || null,
    isEnterpriseInstall: toBool(payload.is_enterprise_install),
    userId: payload.user?.id || null,
    channelId: payload.channel?.id || payload.container?.channel_id || null,
    triggerId: payload.trigger_id || null,
    responseUrl: payload.response_url || null,
    retry: null,
  };
}

function normalizeCommand(fields) {
  return {
    kind: 'command',
    id: fields.command || '',
    payload: fields,
    teamId: fields.team_id || null,
    enterpriseId: fields.enterprise_id || null,
    isEnterpriseInstall: toBool(fields.is_enterprise_install),
    userId: fields.user_id || null,
    channelId: fields.channel_id || null,
    triggerId: fields.trigger_id || null,
    responseUrl: fields.response_url || null,
    retry: null,
  };
}

function normalizeEvent(envelope, retry) {
  const event = envelope.event || {};
  return {
    kind: 'event',
    id: event.type || '',
    payload: envelope,
    teamId: envelope.team_id || event.team || null,
    enterpriseId: envelope.enterprise_id || null,
    isEnterpriseInstall: toBool(envelope.is_enterprise_install),
    userId: event.user || event.user_id || null,
    channelId: event.channel || event.channel_id || null,
    triggerId: null,
    responseUrl: null,
    retry,
  };
}

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * Parse a raw Slack request body into a normalized SlackRequest.
 *
 * @param {Object} options
 * @param {string} options.contentType - The request content-type header
 * @param {string} options.rawBody - Exact raw body (already verified)
 * @param {Object} [options.headers] - Lowercased header lookup for
 *   x-slack-retry-num / x-slack-retry-reason (Events API)
 * @returns {SlackRequest | {kind: 'url_verification', challenge: string}}
 */
export function parseSlackRequest({ contentType = '', rawBody, headers = {} }) {
  const type = contentType.split(';')[0].trim().toLowerCase();

  if (type === 'application/json') {
    const envelope = JSON.parse(rawBody);

    if (envelope.type === 'url_verification') {
      return { kind: 'url_verification', challenge: envelope.challenge };
    }
    if (envelope.type === 'event_callback') {
      const retryNum = headers['x-slack-retry-num'];
      const retry = retryNum
        ? { num: Number(retryNum), reason: headers['x-slack-retry-reason'] || '' }
        : null;
      return normalizeEvent(envelope, retry);
    }
    // app_rate_limited and anything else: surface as an event of that type
    return normalizeEvent({ ...envelope, event: { type: envelope.type } }, null);
  }

  if (type === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(rawBody);

    const payloadField = form.get('payload');
    if (payloadField) {
      return normalizeInteractivity(JSON.parse(payloadField));
    }

    return normalizeCommand(Object.fromEntries(form));
  }

  throw new ParseError(`Unsupported content type: ${contentType}`);
}

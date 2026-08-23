import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSlackRequest, ParseError } from '../lib/parse.js';
import * as payloads from './fixtures/payloads.js';

const FORM = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json';

function parseForm(params) {
  return parseSlackRequest({ contentType: FORM, rawBody: params.toString() });
}

function parseInteractivity(payload) {
  return parseForm(new URLSearchParams({ payload: JSON.stringify(payload) }));
}

function parseJson(body, headers = {}) {
  return parseSlackRequest({ contentType: JSON_TYPE, rawBody: JSON.stringify(body), headers });
}

test('slash command form → command', () => {
  const req = parseForm(payloads.slashCommandForm);

  assert.equal(req.kind, 'command');
  assert.equal(req.id, '/report');
  assert.equal(req.teamId, 'T111');
  assert.equal(req.userId, 'U333');
  assert.equal(req.channelId, 'C222');
  assert.equal(req.triggerId, '444.555.666');
  assert.equal(req.responseUrl, 'https://hooks.slack.com/commands/T111/1/abc');
  assert.equal(req.isEnterpriseInstall, false);
  assert.equal(req.payload.text, 'weekly');
});

test('block_actions → action with first action_id and full list intact', () => {
  const req = parseInteractivity(payloads.blockActions);

  assert.equal(req.kind, 'action');
  assert.equal(req.id, 'open_settings');
  assert.equal(req.payload.actions.length, 2);
  assert.equal(req.teamId, 'T111');
  assert.equal(req.userId, 'U333');
  assert.equal(req.channelId, 'C222');
  assert.equal(req.responseUrl, 'https://hooks.slack.com/actions/T111/1/abc');
});

test('view_submission → view keyed by callback_id', () => {
  const req = parseInteractivity(payloads.viewSubmission);

  assert.equal(req.kind, 'view');
  assert.equal(req.id, 'settings');
  assert.equal(req.triggerId, '444.555.777');
  assert.equal(req.payload.view.state.values.b1.field.value, 'hello');
});

test('view_closed → view_closed', () => {
  const req = parseInteractivity(payloads.viewClosed);
  assert.equal(req.kind, 'view_closed');
  assert.equal(req.id, 'settings');
});

test('global shortcut and message_action → shortcut', () => {
  const globalReq = parseInteractivity(payloads.globalShortcut);
  assert.equal(globalReq.kind, 'shortcut');
  assert.equal(globalReq.id, 'new_task');

  const messageReq = parseInteractivity(payloads.messageAction);
  assert.equal(messageReq.kind, 'shortcut');
  assert.equal(messageReq.id, 'summarize_message');
  assert.equal(messageReq.channelId, 'C222');
  assert.equal(messageReq.responseUrl, 'https://hooks.slack.com/app/T111/1/abc');
});

test('block_suggestion → options', () => {
  const req = parseInteractivity(payloads.blockSuggestion);
  assert.equal(req.kind, 'options');
  assert.equal(req.id, 'project_picker');
  assert.equal(req.payload.value, 'acm');
});

test('event_callback → event with retry headers surfaced', () => {
  const fresh = parseJson(payloads.eventCallback);
  assert.equal(fresh.kind, 'event');
  assert.equal(fresh.id, 'app_mention');
  assert.equal(fresh.teamId, 'T111');
  assert.equal(fresh.userId, 'U333');
  assert.equal(fresh.channelId, 'C222');
  assert.equal(fresh.retry, null);

  const retried = parseJson(payloads.eventCallback, {
    'x-slack-retry-num': '2',
    'x-slack-retry-reason': 'http_timeout',
  });
  assert.deepEqual(retried.retry, { num: 2, reason: 'http_timeout' });
});

test('url_verification → challenge echo shape', () => {
  const req = parseJson(payloads.urlVerification);
  assert.deepEqual(req, { kind: 'url_verification', challenge: payloads.urlVerification.challenge });
});

test('content-type parameters are tolerated', () => {
  const req = parseSlackRequest({
    contentType: 'application/json; charset=utf-8',
    rawBody: JSON.stringify(payloads.eventCallback),
  });
  assert.equal(req.kind, 'event');
});

test('unknown content type and unknown interactivity type throw ParseError', () => {
  assert.throws(
    () => parseSlackRequest({ contentType: 'text/plain', rawBody: 'x' }),
    ParseError
  );
  assert.throws(
    () => parseInteractivity({ type: 'mystery_payload' }),
    /Unknown interactivity payload type/
  );
});

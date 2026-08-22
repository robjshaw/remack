'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ErrorCode } = require('@slack/bolt');

const {
  ackSafely,
  mapWithConcurrency,
  splitSlackTextChunks,
  isSlackNotFoundError,
  isDirectMessageEvent,
  normalizeMultilineNote,
  extractUserId,
} = require('../lib/helpers');
const { fakeLogger } = require('./fakes');

test('ackSafely returns true on success and passes payload', async () => {
  let received;
  const ok = await ackSafely(async (payload) => { received = payload; }, { text: 'hi' }, { logger: fakeLogger() });
  assert.equal(ok, true);
  assert.deepEqual(received, { text: 'hi' });
});

test('ackSafely returns false for non-function', async () => {
  assert.equal(await ackSafely(undefined), false);
});

test('ackSafely swallows multiple-ack errors quietly', async () => {
  const logger = fakeLogger();
  const err = new Error('already acked');
  err.code = ErrorCode.ReceiverMultipleAckError;
  const ok = await ackSafely(async () => { throw err; }, undefined, { logger });
  assert.equal(ok, false);
  assert.equal(logger.entries[0].level, 'debug');
});

test('ackSafely warns on deferred-request timeout', async () => {
  const logger = fakeLogger();
  const err = new Error('timed out');
  err.code = ErrorCode.HTTPReceiverDeferredRequestError;
  const ok = await ackSafely(async () => { throw err; }, undefined, { logger });
  assert.equal(ok, false);
  assert.equal(logger.entries[0].level, 'warn');
});

test('ackSafely logs error for unknown failures', async () => {
  const logger = fakeLogger();
  const ok = await ackSafely(async () => { throw new Error('boom'); }, undefined, { logger });
  assert.equal(ok, false);
  assert.equal(logger.entries[0].level, 'error');
});

test('mapWithConcurrency preserves order and caps concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const items = [5, 4, 3, 2, 1];

  const results = await mapWithConcurrency(items, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, item));
    active -= 1;
    return item * 2;
  }, 2);

  assert.deepEqual(results, [10, 8, 6, 4, 2]);
  assert.ok(maxActive <= 2, `expected concurrency <= 2, saw ${maxActive}`);
});

test('splitSlackTextChunks returns empty array for empty input', () => {
  assert.deepEqual(splitSlackTextChunks(''), []);
  assert.deepEqual(splitSlackTextChunks(null), []);
});

test('splitSlackTextChunks keeps short text whole', () => {
  assert.deepEqual(splitSlackTextChunks('hello'), ['hello']);
});

test('splitSlackTextChunks prefers newline boundaries', () => {
  const text = 'aaaa\nbbbb\ncccc';
  const chunks = splitSlackTextChunks(text, 10);
  assert.deepEqual(chunks, ['aaaa\nbbbb', 'cccc']);
});

test('splitSlackTextChunks hard-splits when no newline available', () => {
  const text = 'a'.repeat(25);
  const chunks = splitSlackTextChunks(text, 10);
  assert.deepEqual(chunks, ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
});

test('isSlackNotFoundError matches platform not_found errors only', () => {
  assert.equal(isSlackNotFoundError({ code: 'slack_webapi_platform_error', data: { error: 'not_found' } }), true);
  assert.equal(isSlackNotFoundError({ code: 'slack_webapi_platform_error', data: { error: 'missing_scope' } }), false);
  assert.equal(isSlackNotFoundError(new Error('nope')), false);
});

test('isDirectMessageEvent detects DMs by channel_type and channel prefix', () => {
  assert.equal(isDirectMessageEvent({ channel_type: 'im' }), true);
  assert.equal(isDirectMessageEvent({ channel: 'D12345' }), true);
  assert.equal(isDirectMessageEvent({ channel: 'C12345' }), false);
  assert.equal(isDirectMessageEvent({}), false);
});

test('normalizeMultilineNote normalizes CRLF, trims lines, and caps length', () => {
  assert.equal(normalizeMultilineNote('a \r\nb  \r\n  '), 'a\nb');
  assert.equal(normalizeMultilineNote('x'.repeat(3000), 100).length, 100);
});

test('extractUserId handles plain IDs and mention formats', () => {
  assert.equal(extractUserId('U12345'), 'U12345');
  assert.equal(extractUserId('u12abc'), 'U12ABC');
  assert.equal(extractUserId('<@U12345>'), 'U12345');
  assert.equal(extractUserId('<@U12345|robsh>'), 'U12345');
  assert.equal(extractUserId('not a mention'), null);
  assert.equal(extractUserId(null), null);
});

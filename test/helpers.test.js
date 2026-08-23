import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapWithConcurrency,
  splitSlackTextChunks,
  isDirectMessageEvent,
  extractUserId,
} from '../lib/helpers.js';
import { normalizeLogger } from '../lib/logger.js';
import { fakeLogger } from './fakes.js';

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

test('splitSlackTextChunks handles empty, short, newline, and hard-split cases', () => {
  assert.deepEqual(splitSlackTextChunks(''), []);
  assert.deepEqual(splitSlackTextChunks('hello'), ['hello']);
  assert.deepEqual(splitSlackTextChunks('aaaa\nbbbb\ncccc', 10), ['aaaa\nbbbb', 'cccc']);
  assert.deepEqual(splitSlackTextChunks('a'.repeat(25), 10), ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
});

test('isDirectMessageEvent detects DMs by channel_type and channel prefix', () => {
  assert.equal(isDirectMessageEvent({ channel_type: 'im' }), true);
  assert.equal(isDirectMessageEvent({ channel: 'D12345' }), true);
  assert.equal(isDirectMessageEvent({ channel: 'C12345' }), false);
  assert.equal(isDirectMessageEvent({}), false);
});

test('extractUserId handles plain IDs and mention formats', () => {
  assert.equal(extractUserId('U12345'), 'U12345');
  assert.equal(extractUserId('u12abc'), 'U12ABC');
  assert.equal(extractUserId('<@U12345>'), 'U12345');
  assert.equal(extractUserId('<@U12345|robsh>'), 'U12345');
  assert.equal(extractUserId('not a mention'), null);
  assert.equal(extractUserId(null), null);
});

test('normalizeLogger passes through logger-likes and falls back to console shape', () => {
  const logger = fakeLogger();
  assert.equal(normalizeLogger(logger), logger);

  const fallback = normalizeLogger(null);
  for (const level of ['debug', 'info', 'warn', 'error']) {
    assert.equal(typeof fallback[level], 'function');
  }
  assert.equal(typeof fallback.child, 'function');
});

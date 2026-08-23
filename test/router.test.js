import { test } from 'node:test';
import assert from 'node:assert/strict';

import { route, createRouter, unmatchedAckValue, validateModule } from '../lib/router.js';
import { fakeLogger } from './fakes.js';

const noop = { default: async () => {} };

test('route() validates kind, id, and module shape', () => {
  assert.throws(() => route('bogus', 'x', noop), /Unknown route kind/);
  assert.throws(() => route('action', 42, noop), /string or RegExp/);
  assert.throws(() => route('action', 'x', {}), /default handler or render/);
  assert.throws(() => route('action', 'x', { default: async () => {}, loader: 'nope' }), /'loader' export|export 'loader'/);

  const def = route('action', 'ok', noop);
  assert.deepEqual({ kind: def.kind, id: def.id }, { kind: 'action', id: 'ok' });
});

test('render-only modules are valid (declarative surfaces)', () => {
  validateModule('event', 'app_home_opened', { render: () => ({ type: 'home', blocks: [] }) });
});

test('match: exact string beats pattern; patterns in order; miss → null', () => {
  const exact = route('action', 'row_special', { default: async () => 'exact' });
  const patternA = route('action', /^row_/, { default: async () => 'a' });
  const patternB = route('action', /^row_.*_end$/, { default: async () => 'b' });
  const router = createRouter({ routes: [patternA, patternB, exact], logger: fakeLogger() });

  assert.equal(router.match('action', 'row_special'), exact);
  assert.equal(router.match('action', 'row_other'), patternA);
  assert.equal(router.match('action', 'unrelated'), null);
  assert.equal(router.match('view', 'row_special'), null, 'kinds are isolated');
});

test('duplicate string ids warn and later wins', () => {
  const logger = fakeLogger();
  const first = route('command', '/dup', { default: async () => 1 });
  const second = route('command', '/dup', { default: async () => 2 });
  const router = createRouter({ routes: [first, second], logger });

  assert.equal(router.match('command', '/dup'), second);
  const warning = logger.entries.find((e) => e.level === 'warn');
  assert.ok(warning);
  assert.equal(warning.objOrMsg.id, '/dup');
});

test('unmatchedAckValue: empty options body for options, empty ack otherwise', () => {
  assert.deepEqual(unmatchedAckValue('options'), { options: [] });
  assert.equal(unmatchedAckValue('action'), undefined);
  assert.equal(unmatchedAckValue('event'), undefined);
});

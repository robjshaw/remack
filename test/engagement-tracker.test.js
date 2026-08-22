'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createEngagementTracker, CoreEventType } = require('../lib/engagement-tracker');
const { fakePool, fakeLogger } = require('./fakes');

test('EventType merges CoreEventType with injected app events', () => {
  const tracker = createEngagementTracker({
    logger: fakeLogger(),
    eventTypes: { SEARCH_COMPLETED: 'search_completed' },
  });

  assert.equal(tracker.EventType.HOME_OPENED, CoreEventType.HOME_OPENED);
  assert.equal(tracker.EventType.SEARCH_COMPLETED, 'search_completed');
  assert.ok(Object.isFrozen(tracker.EventType));
});

test('trackEvent inserts with full param mapping', async () => {
  const pool = fakePool([{ rows: [{ id: 42 }] }]);
  const tracker = createEngagementTracker({ pool, logger: fakeLogger() });

  const id = await tracker.trackEvent('search_completed', {
    userId: 'U1',
    userName: 'Rob',
    teamId: 'T1',
    channelId: 'C1',
    feature: 'search',
    searchQuery: 'acme',
    resultCount: 9,
    durationMs: 120,
    success: false,
    metadata: { source: 'modal' },
  });

  assert.equal(id, 42);
  const { text, params } = pool.calls[0];
  assert.match(text, /INSERT INTO slack_analytics/);
  assert.deepEqual(params, ['search_completed', 'U1', 'Rob', 'T1', 'C1', 'search', 'acme', 9, 120, false, '{"source":"modal"}']);
});

test('trackEvent no-ops without pool or userId', async () => {
  const noDb = createEngagementTracker({ logger: fakeLogger() });
  assert.equal(await noDb.trackEvent('x', { userId: 'U1' }), null);

  const pool = fakePool();
  const tracker = createEngagementTracker({ pool, logger: fakeLogger() });
  assert.equal(await tracker.trackEvent('x', {}), null);
  assert.equal(pool.calls.length, 0);
});

test('defineTracker merges defaults, per-call data, and metadata', async () => {
  const pool = fakePool([{ rows: [{ id: 1 }] }]);
  const tracker = createEngagementTracker({ pool, logger: fakeLogger() });

  const trackSearch = tracker.defineTracker('search_completed', { feature: 'search', metadata: { surface: 'modal' } });
  await trackSearch({ userId: 'U1', metadata: { query: 'acme' } });

  const params = pool.calls[0].params;
  assert.equal(params[5], 'search');
  assert.deepEqual(JSON.parse(params[10]), { surface: 'modal', query: 'acme' });
});

test('recordHomeOpen returns visit stats and degrades without pool', async () => {
  const pool = fakePool([
    { rows: [{ visit_count: '2', last_visit: '2026-08-01T00:00:00Z' }] },
    { rows: [{ id: 11 }] },
  ]);
  const tracker = createEngagementTracker({ pool, logger: fakeLogger() });

  const result = await tracker.recordHomeOpen('U1', 'T1');
  assert.equal(result.isFirstVisit, false);
  assert.equal(result.visitCount, 3);
  assert.equal(result.engagementId, 11);
  assert.match(pool.calls[1].text, /INSERT INTO slack_engagement/);

  const noDb = createEngagementTracker({ logger: fakeLogger() });
  assert.deepEqual(await noDb.recordHomeOpen('U1', 'T1'), {
    isFirstVisit: true, lastVisit: null, visitCount: 0, engagementId: null,
  });
});

test('recordAction updates the engagement row', async () => {
  const pool = fakePool([{ rows: [] }]);
  const tracker = createEngagementTracker({ pool, logger: fakeLogger() });

  await tracker.recordAction(11, 'open_report');
  assert.match(pool.calls[0].text, /SET action_taken = TRUE/);
  assert.deepEqual(pool.calls[0].params, ['open_report', 11]);

  // No engagementId → no query
  await tracker.recordAction(null, 'x');
  assert.equal(pool.calls.length, 1);
});

test('isUserDormant treats never-visited as dormant and errors as not dormant', async () => {
  const pool = fakePool([{ rows: [{ last_visit: null }] }]);
  const tracker = createEngagementTracker({ pool, logger: fakeLogger() });
  assert.equal(await tracker.isUserDormant('U1'), true);

  const erroring = createEngagementTracker({ pool: fakePool(() => { throw new Error('down'); }), logger: fakeLogger() });
  assert.equal(await erroring.isUserDormant('U1'), false);
});

test('custom table names are used and validated', async () => {
  assert.throws(() => createEngagementTracker({ tables: { analytics: 'x y' } }), /Invalid/);

  const pool = fakePool([{ rows: [{ id: 1 }] }]);
  const tracker = createEngagementTracker({ pool, logger: fakeLogger(), tables: { analytics: 'app.events' } });
  await tracker.trackEvent('x', { userId: 'U1' });
  assert.match(pool.calls[0].text, /INSERT INTO app\.events/);
});

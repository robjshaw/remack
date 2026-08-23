import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngagementTracker, CoreEventType } from '../ext/engagement-tracker.js';
import { fakePool, fakeLogger } from './fakes.js';

test('EventType merges CoreEventType with injected app events and is frozen', () => {
  const tracker = createEngagementTracker({
    logger: fakeLogger(),
    eventTypes: { SEARCH_COMPLETED: 'search_completed' },
  });

  assert.equal(tracker.EventType.HOME_OPENED, CoreEventType.HOME_OPENED);
  assert.equal(tracker.EventType.SEARCH_COMPLETED, 'search_completed');
  assert.ok(Object.isFrozen(tracker.EventType));
});

test('trackEvent inserts with full param mapping; no-ops without pool or userId', async () => {
  const pool = fakePool([{ rows: [{ id: 42 }] }]);
  const tracker = createEngagementTracker({ pool, logger: fakeLogger() });

  const id = await tracker.trackEvent('search_completed', {
    userId: 'U1', userName: 'Rob', teamId: 'T1', channelId: 'C1',
    feature: 'search', searchQuery: 'acme', resultCount: 9, durationMs: 120,
    success: false, metadata: { source: 'modal' },
  });

  assert.equal(id, 42);
  assert.match(pool.calls[0].text, /INSERT INTO slack_analytics/);
  assert.deepEqual(pool.calls[0].params,
    ['search_completed', 'U1', 'Rob', 'T1', 'C1', 'search', 'acme', 9, 120, false, '{"source":"modal"}']);

  const noDb = createEngagementTracker({ logger: fakeLogger() });
  assert.equal(await noDb.trackEvent('x', { userId: 'U1' }), null);

  assert.equal(await tracker.trackEvent('x', {}), null, 'missing userId → null');
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

  const noDb = createEngagementTracker({ logger: fakeLogger() });
  assert.deepEqual(await noDb.recordHomeOpen('U1', 'T1'),
    { isFirstVisit: true, lastVisit: null, visitCount: 0, engagementId: null });
});

test('recordAction updates the row; skipped without engagementId', async () => {
  const pool = fakePool([{ rows: [] }]);
  const tracker = createEngagementTracker({ pool, logger: fakeLogger() });

  await tracker.recordAction(11, 'open_report');
  assert.deepEqual(pool.calls[0].params, ['open_report', 11]);

  await tracker.recordAction(null, 'x');
  assert.equal(pool.calls.length, 1);
});

test('isUserDormant: never-visited → dormant; DB error → not dormant', async () => {
  const pool = fakePool([{ rows: [{ last_visit: null }] }]);
  const tracker = createEngagementTracker({ pool, logger: fakeLogger() });
  assert.equal(await tracker.isUserDormant('U1'), true);

  const erroring = createEngagementTracker({ pool: fakePool(() => { throw new Error('down'); }), logger: fakeLogger() });
  assert.equal(await erroring.isUserDormant('U1'), false);
});

test('table names are injectable and validated', async () => {
  assert.throws(() => createEngagementTracker({ tables: { analytics: 'x y' } }), /Invalid/);

  const pool = fakePool([{ rows: [{ id: 1 }] }]);
  const tracker = createEngagementTracker({ pool, logger: fakeLogger(), tables: { analytics: 'app.events' } });
  await tracker.trackEvent('x', { userId: 'U1' });
  assert.match(pool.calls[0].text, /INSERT INTO app\.events/);
});

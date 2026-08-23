import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngagementTracker, CoreEventType } from '../ext/engagement-tracker.js';
import { memoryStorage } from '../lib/storage.js';
import { fakeLogger } from './fakes.js';

function makeTracker(overrides = {}) {
  return createEngagementTracker({ storage: memoryStorage(), logger: fakeLogger(), ...overrides });
}

test('requires storage; EventType merges CoreEventType with app events and is frozen', () => {
  assert.throws(() => createEngagementTracker({}), /storage/);

  const tracker = makeTracker({ eventTypes: { SEARCH_COMPLETED: 'search_completed' } });
  assert.equal(tracker.EventType.HOME_OPENED, CoreEventType.HOME_OPENED);
  assert.equal(tracker.EventType.SEARCH_COMPLETED, 'search_completed');
  assert.ok(Object.isFrozen(tracker.EventType));
});

test('trackEvent stores the event and feeds getFeatureUsage aggregates', async () => {
  const tracker = makeTracker();

  const key = await tracker.trackEvent('search_completed', {
    userId: 'U1', userName: 'Rob', feature: 'search',
    searchQuery: 'acme', resultCount: 9, durationMs: 100, metadata: { surface: 'modal' },
  });
  assert.ok(key);

  await tracker.trackEvent('search_completed', { userId: 'U2', feature: 'search', durationMs: 300 });
  await tracker.trackEvent('search_completed', { userId: 'U1', feature: 'search', success: false });
  await tracker.trackEvent('export', { userId: 'U1', feature: 'reports' });

  const usage = await tracker.getFeatureUsage(30);
  const search = usage.find((row) => row.feature === 'search');
  assert.equal(search.eventCount, 3);
  assert.equal(search.uniqueUsers, 2);
  assert.equal(search.avgDurationMs, 200);
  assert.equal(search.errorCount, 1);
  assert.ok(usage.find((row) => row.feature === 'reports'));

  assert.equal(await tracker.trackEvent('x', {}), null, 'missing userId → null');
});

test('defineTracker merges defaults, per-call data, and metadata', async () => {
  const storage = memoryStorage();
  const tracker = makeTracker({ storage });

  const trackSearch = tracker.defineTracker('search_completed', { feature: 'search', metadata: { surface: 'modal' } });
  await trackSearch({ userId: 'U1', metadata: { query: 'acme' } });

  const [entry] = await storage.list('analytics');
  assert.equal(entry.value.feature, 'search');
  assert.deepEqual(entry.value.metadata, { surface: 'modal', query: 'acme' });
});

test('recordHomeOpen tracks visit history per user and tab', async () => {
  const tracker = makeTracker();

  const first = await tracker.recordHomeOpen('U1', 'T1');
  assert.equal(first.isFirstVisit, true);
  assert.equal(first.visitCount, 1);
  assert.ok(first.engagementId);

  const second = await tracker.recordHomeOpen('U1', 'T1');
  assert.equal(second.isFirstVisit, false);
  assert.equal(second.visitCount, 2);
  assert.ok(second.lastVisit);

  const otherUser = await tracker.recordHomeOpen('U2', 'T1');
  assert.equal(otherUser.isFirstVisit, true, 'histories are per-user');
});

test('recordAction marks the visit; getAnalytics computes conversion', async () => {
  const tracker = makeTracker();

  const visit1 = await tracker.recordHomeOpen('U1', 'T1');
  await tracker.recordHomeOpen('U2', 'T1');
  await tracker.recordAction(visit1.engagementId, 'open_report');
  await tracker.recordAction(null, 'ignored');
  await tracker.recordAction('missing-id', 'ignored');

  const analytics = await tracker.getAnalytics(30);
  assert.equal(analytics.uniqueUsers, 2);
  assert.equal(analytics.totalVisits, 2);
  assert.equal(analytics.visitsWithAction, 1);
  assert.equal(analytics.conversionRate, 50);
  assert.equal(analytics.weeklyActiveUsers, 2);
});

test('isUserDormant: never-visited → dormant; fresh visit → active', async () => {
  const tracker = makeTracker();
  assert.equal(await tracker.isUserDormant('U_GHOST'), true);

  await tracker.recordHomeOpen('U1', 'T1');
  assert.equal(await tracker.isUserDormant('U1', 14), false);
});

test('storage failures degrade instead of throwing', async () => {
  const fail = async () => { throw new Error('down'); };
  const tracker = makeTracker({ storage: { get: fail, put: fail, delete: fail, list: fail } });

  assert.equal(await tracker.trackEvent('x', { userId: 'U1' }), null);
  assert.deepEqual(await tracker.recordHomeOpen('U1', 'T1'),
    { isFirstVisit: true, lastVisit: null, visitCount: 0, engagementId: null });
  assert.equal(await tracker.getAnalytics(), null);
  assert.equal(await tracker.getFeatureUsage(), null);
  assert.equal(await tracker.isUserDormant('U1'), false);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPlanBlock,
  createSteps,
  updateStepProgress,
  buildCompletionBlocks,
  STATUS_EMOJI,
} = require('../lib/plan-block');

test('createSteps builds pending steps from names', () => {
  assert.deepEqual(createSteps(['Parse', 'Enrich']), [
    { name: 'Parse', status: 'pending' },
    { name: 'Enrich', status: 'pending' },
  ]);
  assert.deepEqual(createSteps(), []);
});

test('buildPlanBlock renders header, steps with emoji, and details', () => {
  const blocks = buildPlanBlock({
    title: 'Working',
    steps: [
      { name: 'Parse', status: 'complete' },
      { name: 'Enrich', status: 'in_progress', detail: '3 of 9' },
    ],
  });

  assert.equal(blocks[0].type, 'header');
  assert.equal(blocks[0].text.text, 'Working');
  assert.equal(
    blocks[1].text.text,
    `${STATUS_EMOJI.complete} Parse\n${STATUS_EMOJI.in_progress} Enrich - 3 of 9`
  );
  assert.equal(blocks.length, 2);
});

test('buildPlanBlock appends error block when error given', () => {
  const blocks = buildPlanBlock({ title: 'Failed', steps: [{ name: 'Parse', status: 'error' }], error: 'nope' });
  assert.equal(blocks[2].text.text, ':x: *Error:* nope');
});

test('updateStepProgress marks previous complete and updates current by key', () => {
  const steps = createSteps(['Parse input', 'Enrich data', 'Generate output']);
  const updated = updateStepProgress(steps, 'enrich', 'in_progress', 'halfway');

  assert.equal(updated[0].status, 'complete');
  assert.equal(updated[1].status, 'in_progress');
  assert.equal(updated[1].detail, 'halfway');
  assert.equal(updated[2].status, 'pending');
});

test('updateStepProgress accepts explicit stepKeys and numeric index', () => {
  const steps = createSteps(['One', 'Two', 'Three']);

  const byKey = updateStepProgress(steps, 'b', 'in_progress', undefined, { stepKeys: ['a', 'b', 'c'] });
  assert.equal(byKey[1].status, 'in_progress');

  const byIndex = updateStepProgress(steps, 2, 'error');
  assert.equal(byIndex[2].status, 'error');
  assert.equal(byIndex[0].status, 'complete');
});

test("updateStepProgress 'complete' marks all steps complete", () => {
  const steps = createSteps(['One', 'Two']);
  const updated = updateStepProgress(steps, 'complete', 'complete');
  assert.ok(updated.every((s) => s.status === 'complete'));
});

test('updateStepProgress does not mutate input', () => {
  const steps = createSteps(['One', 'Two']);
  updateStepProgress(steps, 1, 'in_progress');
  assert.equal(steps[0].status, 'pending');
});

test('buildCompletionBlocks renders link and footer when given', () => {
  const steps = createSteps(['One']);
  const blocks = buildCompletionBlocks({
    steps,
    title: 'All done',
    linkUrl: 'https://example.com/r/1',
    linkText: 'View report',
    footerText: '9 records processed',
  });

  assert.equal(blocks[0].text.text, 'All done');
  assert.equal(blocks.at(-1).text.text, '*<https://example.com/r/1|View report>*\n9 records processed');
});

test('buildCompletionBlocks omits link section when nothing to show', () => {
  const blocks = buildCompletionBlocks({ steps: createSteps(['One']) });
  assert.equal(blocks.length, 2);
});

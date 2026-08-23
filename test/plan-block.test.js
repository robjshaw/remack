import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlanBlock,
  createSteps,
  updateStepProgress,
  buildCompletionBlocks,
  STATUS_EMOJI,
} from '../ext/plan-block.js';

test('createSteps builds pending steps from names', () => {
  assert.deepEqual(createSteps(['Parse', 'Enrich']), [
    { name: 'Parse', status: 'pending' },
    { name: 'Enrich', status: 'pending' },
  ]);
  assert.deepEqual(createSteps(), []);
});

test('buildPlanBlock renders header, steps with emoji, details, and errors', () => {
  const blocks = buildPlanBlock({
    title: 'Working',
    steps: [
      { name: 'Parse', status: 'complete' },
      { name: 'Enrich', status: 'in_progress', detail: '3 of 9' },
    ],
  });

  assert.equal(blocks[0].type, 'header');
  assert.equal(
    blocks[1].text.text,
    `${STATUS_EMOJI.complete} Parse\n${STATUS_EMOJI.in_progress} Enrich - 3 of 9`
  );

  const failed = buildPlanBlock({ title: 'F', steps: [{ name: 'P', status: 'error' }], error: 'nope' });
  assert.equal(failed[2].text.text, ':x: *Error:* nope');
});

test('updateStepProgress transitions by key, index, stepKeys, and complete', () => {
  const steps = createSteps(['Parse input', 'Enrich data', 'Generate output']);

  const byKey = updateStepProgress(steps, 'enrich', 'in_progress', 'halfway');
  assert.equal(byKey[0].status, 'complete');
  assert.equal(byKey[1].status, 'in_progress');
  assert.equal(byKey[1].detail, 'halfway');
  assert.equal(byKey[2].status, 'pending');

  const byIndex = updateStepProgress(steps, 2, 'error');
  assert.equal(byIndex[2].status, 'error');

  const byKeys = updateStepProgress(steps, 'b', 'in_progress', undefined, { stepKeys: ['a', 'b', 'c'] });
  assert.equal(byKeys[1].status, 'in_progress');

  const done = updateStepProgress(steps, 'complete', 'complete');
  assert.ok(done.every((s) => s.status === 'complete'));

  assert.equal(steps[0].status, 'pending', 'input not mutated');
});

test('buildCompletionBlocks renders optional link and footer', () => {
  const blocks = buildCompletionBlocks({
    steps: createSteps(['One']),
    title: 'All done',
    linkUrl: 'https://example.com/r/1',
    linkText: 'View report',
    footerText: '9 records',
  });
  assert.equal(blocks.at(-1).text.text, '*<https://example.com/r/1|View report>*\n9 records');

  assert.equal(buildCompletionBlocks({ steps: createSteps(['One']) }).length, 2);
});

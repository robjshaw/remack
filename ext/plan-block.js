/**
 * Plan Block Builder
 *
 * Renders step-by-step progress UI for async operations (long imports,
 * document processing, multi-stage jobs). Post the blocks once, then
 * chat.update the same message as steps advance.
 */

export const STATUS_EMOJI = {
  pending: ':white_circle:',
  in_progress: ':large_blue_circle:',
  complete: ':white_check_mark:',
  error: ':x:',
};

/**
 * Build a plan block showing processing steps with status indicators.
 * @param {Object} options
 * @param {string} options.title - Header text
 * @param {Array<{name: string, status: string, detail?: string}>} options.steps
 * @param {string} [options.error] - Error message if failed
 * @returns {Array} Slack blocks
 */
export function buildPlanBlock({ title, steps, error }) {
  const stepText = steps
    .map(s => {
      const emoji = STATUS_EMOJI[s.status] || STATUS_EMOJI.pending;
      const detail = s.detail ? ` - ${s.detail}` : '';
      return `${emoji} ${s.name}${detail}`;
    })
    .join('\n');

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: title, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: stepText },
    },
  ];

  if (error) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:x: *Error:* ${error}` },
    });
  }

  return blocks;
}

/**
 * Build an initial steps array (all pending) from step names.
 * @param {string[]} names
 * @returns {Array<{name: string, status: string}>}
 */
export function createSteps(names) {
  return (names || []).map(name => ({ name, status: 'pending' }));
}

/**
 * Update step statuses based on progress.
 *
 * `currentStep` may be a step key (see `stepKeys`), a step index, or the
 * special value 'complete' which marks every step complete. All steps before
 * the current one are marked complete.
 *
 * @param {Array} steps - Current steps array
 * @param {string|number} currentStep - Step key, index, or 'complete'
 * @param {string} status - Status (in_progress, complete, error)
 * @param {string} [detail] - Optional detail text
 * @param {Object} [options]
 * @param {string[]} [options.stepKeys] - Keys identifying each step by
 *   position; defaults to lowercased first word of each step name
 * @returns {Array} Updated steps array
 */
export function updateStepProgress(steps, currentStep, status, detail, { stepKeys } = {}) {
  const keys = stepKeys || steps.map(step => String(step.name || '').trim().toLowerCase().split(/\s+/)[0]);

  let stepIndex;
  if (typeof currentStep === 'number') {
    stepIndex = currentStep;
  } else {
    stepIndex = keys.indexOf(String(currentStep || '').toLowerCase());
    if (stepIndex === -1) stepIndex = undefined;
  }

  const updatedSteps = steps.map(step => ({ ...step }));

  // Mark all previous steps as complete
  for (let i = 0; i < stepIndex; i++) {
    updatedSteps[i].status = 'complete';
  }

  // Update current step
  if (stepIndex !== undefined && stepIndex >= 0 && stepIndex < updatedSteps.length) {
    updatedSteps[stepIndex].status = status;
    if (detail) {
      updatedSteps[stepIndex].detail = detail;
    }
  }

  // If complete, mark all as complete
  if (currentStep === 'complete') {
    updatedSteps.forEach(step => {
      step.status = 'complete';
    });
  }

  return updatedSteps;
}

/**
 * Build completion blocks, optionally with a result link and footer.
 * @param {Object} options
 * @param {Array} options.steps - Final steps array
 * @param {string} [options.title] - Header text (default 'Done!')
 * @param {string} [options.linkUrl] - URL to the result
 * @param {string} [options.linkText] - Link label (default 'View result')
 * @param {string} [options.footerText] - Extra line under the link
 * @returns {Array} Slack blocks
 */
export function buildCompletionBlocks({ steps, title = 'Done!', linkUrl, linkText = 'View result', footerText }) {
  const blocks = buildPlanBlock({ title, steps });

  if (linkUrl || footerText) {
    const lines = [];
    if (linkUrl) lines.push(`*<${linkUrl}|${linkText}>*`);
    if (footerText) lines.push(footerText);

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    });
  }

  return blocks;
}


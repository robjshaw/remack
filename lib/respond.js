/**
 * Ack-value helpers.
 *
 * Route handlers return plain values; these helpers make the valid shapes
 * easy to write and the invalid ones hard.
 *
 * - message() → a message body (slash-command acks, respond() payloads)
 * - view.update/push/errors/clear → view_submission response_actions
 * - options()/optionGroups() → block_suggestion responses
 */

/**
 * Build a message payload. String → ephemeral text; object → merged over
 * ephemeral default.
 *
 * message('hi')                          → { response_type:'ephemeral', text:'hi' }
 * message({ text:'hi', response_type:'in_channel' })
 * message({ blocks, text:'fallback' })
 */
export function message(textOrOpts) {
  if (typeof textOrOpts === 'string') {
    return { response_type: 'ephemeral', text: textOrOpts };
  }
  return { response_type: 'ephemeral', ...textOrOpts };
}

/** view_submission response_action builders. */
export const view = {
  /** Replace the current modal with a complete view object. */
  update(viewObject) {
    return { response_action: 'update', view: viewObject };
  },
  /** Push a new view onto the modal stack (max depth 3). */
  push(viewObject) {
    return { response_action: 'push', view: viewObject };
  },
  /** Show validation errors; keys MUST be block_ids from the submitted view. */
  errors(errorsByBlockId) {
    return { response_action: 'errors', errors: errorsByBlockId };
  },
  /** Close the whole modal stack. */
  clear() {
    return { response_action: 'clear' };
  },
};

/**
 * Build an external-select options response.
 * Accepts ready-made option objects or {text, value} pairs (text may be a
 * plain string).
 */
export function options(list) {
  return {
    options: (list || []).map((option) => normalizeOption(option)),
  };
}

/** Build a grouped options response: [{label, options: [...]}] */
export function optionGroups(groups) {
  return {
    option_groups: (groups || []).map((group) => ({
      label: typeof group.label === 'string'
        ? { type: 'plain_text', text: group.label }
        : group.label,
      options: (group.options || []).map((option) => normalizeOption(option)),
    })),
  };
}

function normalizeOption(option) {
  const text = typeof option.text === 'string'
    ? { type: 'plain_text', text: option.text }
    : option.text;
  return { ...option, text };
}

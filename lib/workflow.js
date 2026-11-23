/**
 * Workflow Builder — Slack custom workflow steps + in-app multi-step workflows.
 *
 * Two complementary primitives that share the same mental model:
 *
 *  1. Slack Workflow Builder custom steps (`defineFunction`, `defineFunctionManifest`,
 *     `Schema`): declare inputs/outputs in Slack's Manifest v2 schema and handle
 *     `function_executed` events as first-class `function.*` routes.
 *
 *  2. In-app multi-step workflows (`createWorkflow`): chain automated and
 *     human-in-the-loop steps (approvals, modals, actions) with persisted run
 *     state in remack's KV storage and auto-wired `RouteDef[]`.
 */

import { route } from './router.js';
import { memoryStorage } from './storage.js';

// ── 1. Slack Workflow Builder Custom Steps ───────────────────────────────────

/**
 * Parameter type constants for Slack App Manifest v2 `functions` definitions.
 * See https://docs.slack.dev/reference/workflows/
 */
export const Schema = Object.freeze({
  string: 'string',
  boolean: 'boolean',
  integer: 'integer',
  number: 'number',
  user_id: 'slack#/types/user_id',
  channel_id: 'slack#/types/channel_id',
  usergroup_id: 'slack#/types/usergroup_id',
  timestamp: 'slack#/types/timestamp',
  message_ts: 'slack#/types/message_ts',
  rich_text: 'slack#/types/rich_text',
  interactivity: 'slack#/types/interactivity',
});

function buildParameterBlock(params = {}) {
  const properties = {};
  const required = [];

  for (const [name, spec] of Object.entries(params)) {
    const def = typeof spec === 'string' ? { type: spec } : { ...spec };
    const isRequired = Boolean(def.required);
    delete def.required;

    // Resolve shorthand names like 'user_id' → 'slack#/types/user_id'
    if (def.type && Schema[def.type]) {
      def.type = Schema[def.type];
    }
    if (!def.type) def.type = Schema.string;
    if (!def.title) def.title = name;

    properties[name] = def;
    if (isRequired) required.push(name);
  }

  return {
    properties,
    ...(required.length ? { required } : {}),
  };
}

/**
 * Build a Slack Manifest v2 function definition block.
 * Export this as `export const manifest = defineFunctionManifest({ ... })`
 * inside `routes/function.<callback_id>.js` so `remack manifest` emits the
 * exact `functions.<callback_id>` schema automatically.
 *
 * @param {Object} options
 * @param {string} options.title - Human-readable step title in Workflow Builder
 * @param {string} [options.description]
 * @param {Object} [options.inputs] - Map of name → { type, title?, description?, hint?, default?, required? }
 * @param {Object} [options.outputs] - Map of name → { type, title?, description?, required? }
 */
export function defineFunctionManifest({ title, description = '', inputs = {}, outputs = {} } = {}) {
  if (!title) throw new Error('defineFunctionManifest requires a title');
  return {
    title,
    ...(description ? { description } : {}),
    input_parameters: buildParameterBlock(inputs),
    output_parameters: buildParameterBlock(outputs),
  };
}

/**
 * Declare a Slack custom workflow step as a programmatic RouteDef.
 * Pass the returned RouteDef directly in `createApp({ routes: [step] })`.
 *
 * @param {Object} options
 * @param {string} options.id - Function callback_id
 * @param {string} options.title - Human-readable step title
 * @param {string} [options.description]
 * @param {Object} [options.inputs]
 * @param {Object} [options.outputs]
 * @param {Function} [options.loader]
 * @param {Function} [options.default] - Handler (or pass `handler`)
 * @param {Function} [options.handler] - Alias for `default`
 * @param {Function} [options.ErrorBoundary]
 */
export function defineFunction({
  id,
  title,
  description = '',
  inputs = {},
  outputs = {},
  loader,
  default: defaultHandler,
  handler,
  ErrorBoundary,
} = {}) {
  if (!id || typeof id !== 'string') {
    throw new Error('defineFunction requires a string id (callback_id)');
  }
  const fn = defaultHandler ?? handler;
  const manifest = defineFunctionManifest({ title: title || id, description, inputs, outputs });
  const mod = {
    manifest,
    default: fn,
    ...(loader ? { loader } : {}),
    ...(ErrorBoundary ? { ErrorBoundary } : {}),
  };
  return route('function', id, mod);
}

// ── 2. In-app Multi-Step Workflow Builder ────────────────────────────────────

const PAUSE_SYMBOL = Symbol('remack.workflow.pause');
const WORKFLOW_NS = 'workflows';

function isPauseSignal(value) {
  return Boolean(value && typeof value === 'object' && value[PAUSE_SYMBOL] === true);
}

/**
 * Signal returned from a step's `run()` to pause a workflow run and wait
 * for external input (a button click, modal submission, or `workflow.resume()`).
 */
export function pause(meta = {}) {
  return { [PAUSE_SYMBOL]: true, meta };
}

function makeRunId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const STATUS_EMOJI = {
  pending: ':white_square:',
  running: ':hourglass_flowing_sand:',
  waiting: ':double_vertical_bar:',
  done: ':white_check_mark:',
  failed: ':x:',
  cancelled: ':no_entry_sign:',
};

/**
 * Flatten Slack modal `view.state.values` into `{ [action_id]: value }`.
 * Handles plain_text_input, static_select, multi_static_select, users_select,
 * channels_select, checkboxes, radio_buttons, datepicker, etc.
 */
export function extractViewValues(payload) {
  const values = {};
  const stateValues = payload?.view?.state?.values;
  if (!stateValues || typeof stateValues !== 'object') return values;

  for (const block of Object.values(stateValues)) {
    if (!block || typeof block !== 'object') continue;
    for (const [actionId, field] of Object.entries(block)) {
      if (!field || typeof field !== 'object') continue;
      if (field.value !== undefined) values[actionId] = field.value;
      else if (field.selected_option !== undefined) values[actionId] = field.selected_option?.value ?? null;
      else if (field.selected_options !== undefined) values[actionId] = field.selected_options.map((o) => o.value);
      else if (field.selected_user !== undefined) values[actionId] = field.selected_user;
      else if (field.selected_users !== undefined) values[actionId] = field.selected_users;
      else if (field.selected_channel !== undefined) values[actionId] = field.selected_channel;
      else if (field.selected_channels !== undefined) values[actionId] = field.selected_channels;
      else if (field.selected_conversation !== undefined) values[actionId] = field.selected_conversation;
      else if (field.selected_conversations !== undefined) values[actionId] = field.selected_conversations;
      else if (field.selected_date !== undefined) values[actionId] = field.selected_date;
      else if (field.selected_time !== undefined) values[actionId] = field.selected_time;
      else if (field.selected_date_time !== undefined) values[actionId] = field.selected_date_time;
      else values[actionId] = field;
    }
  }
  return values;
}

/**
 * Create a declarative, stateful multi-step workflow.
 *
 * @param {Object} options
 * @param {string} options.id - Unique workflow identifier (used in storage keys & callback IDs)
 * @param {string} [options.title] - Display title for progress blocks
 * @param {Array<{id: string, title?: string, run: Function, onResume?: Function}>} options.steps
 * @param {Object} [options.storage] - remack storage (default: memoryStorage())
 * @param {{kind: 'command'|'action'|'view'|'shortcut'|'event'|'function', id: string|RegExp, input?: Function}} [options.trigger]
 * @param {Function} [options.onComplete] - Called when all steps finish: ({ run, state, client, args })
 * @param {Function} [options.onError] - Called when a step throws: ({ run, step, error, client, args })
 */
export function createWorkflow({
  id,
  title,
  steps = [],
  storage = memoryStorage(),
  trigger,
  onComplete,
  onError,
} = {}) {
  if (!id || typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error('createWorkflow requires an alphanumeric/dash/underscore string id');
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`Workflow '${id}' requires at least one step`);
  }
  const seenStepIds = new Set();
  for (const step of steps) {
    if (!step?.id || typeof step.id !== 'string') {
      throw new Error(`Every step in workflow '${id}' requires a string id`);
    }
    if (seenStepIds.has(step.id)) {
      throw new Error(`Duplicate step id '${step.id}' in workflow '${id}'`);
    }
    if (typeof step.run !== 'function') {
      throw new Error(`Step '${step.id}' in workflow '${id}' requires a run() function`);
    }
    seenStepIds.add(step.id);
  }

  const displayTitle = title || id;
  const storageKey = (runId) => `${id}:${runId}`;
  const callbackPrefix = `wf:${id}:`;

  async function saveRun(run) {
    run.updatedAt = new Date().toISOString();
    await storage.put(WORKFLOW_NS, storageKey(run.id), run);
    return run;
  }

  async function getRun(runId) {
    return storage.get(WORKFLOW_NS, storageKey(runId));
  }

  async function listRuns({ limit } = {}) {
    const entries = await storage.list(WORKFLOW_NS, { prefix: `${id}:`, limit });
    return entries.map((e) => e.value);
  }

  function actionId(stepId, runId) {
    return `${callbackPrefix}${stepId}:${runId}`;
  }

  function viewId(stepId, runId) {
    return `${callbackPrefix}${stepId}:${runId}`;
  }

  function parseCallback(callbackId) {
    if (typeof callbackId !== 'string' || !callbackId.startsWith(callbackPrefix)) return null;
    const rest = callbackId.slice(callbackPrefix.length);
    const sep = rest.indexOf(':');
    if (sep === -1) return null;
    const stepId = rest.slice(0, sep);
    const runId = rest.slice(sep + 1);
    if (!stepId || !runId) return null;
    return { workflowId: id, stepId, runId };
  }

  async function executeFrom(run, startIndex, { client, args } = {}) {
    run.status = 'running';
    await saveRun(run);

    for (let i = startIndex; i < steps.length; i++) {
      const step = steps[i];
      const stepRecord = run.steps[i];
      run.currentStep = step.id;
      stepRecord.status = 'running';
      await saveRun(run);

      try {
        const result = await step.run({
          runId: run.id,
          run,
          input: run.input,
          state: run.state,
          client,
          args,
          pause,
          actionId: (sid = step.id) => actionId(sid, run.id),
          viewId: (sid = step.id) => viewId(sid, run.id),
        });

        if (isPauseSignal(result)) {
          stepRecord.status = 'waiting';
          stepRecord.pauseMeta = result.meta;
          run.status = 'waiting';
          await saveRun(run);
          return run;
        }

        if (result && typeof result === 'object') {
          Object.assign(run.state, result);
          stepRecord.output = result;
        }
        stepRecord.status = 'done';
        await saveRun(run);
      } catch (error) {
        stepRecord.status = 'failed';
        stepRecord.error = error?.message || String(error);
        run.status = 'failed';
        run.error = stepRecord.error;
        await saveRun(run);
        if (typeof onError === 'function') {
          await onError({ run, step, error, client, args });
          return run;
        }
        throw error;
      }
    }

    run.status = 'completed';
    run.currentStep = null;
    await saveRun(run);
    if (typeof onComplete === 'function') {
      await onComplete({ run, state: run.state, client, args });
    }
    return run;
  }

  /** Start a new workflow run from step 0. */
  async function start(initialInput = {}, { client, args, runId = makeRunId() } = {}) {
    const now = new Date().toISOString();
    const run = {
      id: runId,
      workflowId: id,
      status: 'pending',
      currentStep: steps[0].id,
      input: initialInput,
      state: typeof initialInput === 'object' && initialInput !== null ? { ...initialInput } : {},
      steps: steps.map((s) => ({
        id: s.id,
        title: s.title || s.id,
        status: 'pending',
      })),
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await saveRun(run);
    return executeFrom(run, 0, { client, args });
  }

  /** Resume a paused workflow run at its waiting step and continue execution. */
  async function resume(runId, resumeInput = {}, { client, args } = {}) {
    const run = await getRun(runId);
    if (!run) {
      throw new Error(`Workflow '${id}' run '${runId}' not found`);
    }
    if (run.status !== 'waiting') {
      throw new Error(`Workflow '${id}' run '${runId}' is not waiting (status: ${run.status})`);
    }

    const stepIndex = steps.findIndex((s) => s.id === run.currentStep);
    if (stepIndex === -1) {
      throw new Error(`Workflow '${id}' run '${runId}' has unknown currentStep '${run.currentStep}'`);
    }

    const step = steps[stepIndex];
    const stepRecord = run.steps[stepIndex];

    try {
      if (typeof step.onResume === 'function') {
        const result = await step.onResume({
          runId: run.id,
          run,
          resumeInput,
          input: run.input,
          state: run.state,
          client,
          args,
          pause,
          actionId: (sid = step.id) => actionId(sid, run.id),
          viewId: (sid = step.id) => viewId(sid, run.id),
        });
        if (isPauseSignal(result)) {
          stepRecord.status = 'waiting';
          stepRecord.pauseMeta = result.meta;
          run.status = 'waiting';
          await saveRun(run);
          return run;
        }
        if (result && typeof result === 'object') {
          Object.assign(run.state, result);
          stepRecord.output = result;
        }
      } else if (resumeInput && typeof resumeInput === 'object') {
        Object.assign(run.state, resumeInput);
        stepRecord.output = resumeInput;
      }

      stepRecord.status = 'done';
      await saveRun(run);
    } catch (error) {
      stepRecord.status = 'failed';
      stepRecord.error = error?.message || String(error);
      run.status = 'failed';
      run.error = stepRecord.error;
      await saveRun(run);
      if (typeof onError === 'function') {
        await onError({ run, step, error, client, args });
        return run;
      }
      throw error;
    }

    return executeFrom(run, stepIndex + 1, { client, args });
  }

  /** Cancel a pending/waiting/running workflow run. */
  async function cancel(runId, reason = 'Cancelled') {
    const run = await getRun(runId);
    if (!run) return null;
    run.status = 'cancelled';
    run.error = reason;
    const idx = steps.findIndex((s) => s.id === run.currentStep);
    if (idx !== -1 && (run.steps[idx].status === 'waiting' || run.steps[idx].status === 'running')) {
      run.steps[idx].status = 'cancelled';
    }
    return saveRun(run);
  }

  /** Render Block Kit progress blocks for a workflow run. */
  function renderProgress(run) {
    const lines = run.steps.map((s) => {
      const emoji = STATUS_EMOJI[s.status] || ':white_square:';
      const detail = s.error ? ` — _${s.error}_` : '';
      return `${emoji} *${s.title}*${detail}`;
    });
    return [
      {
        type: 'header',
        text: { type: 'plain_text', text: displayTitle, emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n') },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `Run \`${run.id}\` · Status: *${run.status}*` },
        ],
      },
    ];
  }

  /**
   * Generate remack RouteDefs for this workflow:
   *  - Optional trigger route (if `trigger` was configured)
   *  - Wildcard `action` and `view` resume routes matching `wf:<id>:<stepId>:<runId>`
   */
  function routes() {
    const pattern = new RegExp(`^wf:${id}:[^:]+:.+$`);
    const defs = [
      route('action', pattern, {
        default: async (args) => {
          const parsed = parseCallback(args.id);
          if (!parsed) return;
          const action = args.payload.actions?.[0] || {};
          const resumeInput = {
            userId: args.userId,
            channelId: args.channelId,
            actionId: args.id,
            value: action.value ?? action.selected_option?.value ?? null,
            action,
          };
          args.defer(() => resume(parsed.runId, resumeInput, { client: args.client, args }));
        },
      }),
      route('view', pattern, {
        default: async (args) => {
          const parsed = parseCallback(args.id);
          if (!parsed) return;
          const resumeInput = {
            userId: args.userId,
            values: extractViewValues(args.payload),
            view: args.payload.view,
          };
          args.defer(() => resume(parsed.runId, resumeInput, { client: args.client, args }));
        },
      }),
    ];

    if (trigger) {
      const extractInput = typeof trigger.input === 'function'
        ? trigger.input
        : (args) => (args.kind === 'function'
          ? { ...args.inputs }
          : { text: args.payload?.text || '', userId: args.userId, channelId: args.channelId });

      defs.unshift(route(trigger.kind, trigger.id, {
        default: async (args) => {
          const initialInput = extractInput(args);
          if (args.kind === 'function') {
            const run = await start(initialInput, { client: args.client, args });
            if (run.status === 'completed') return run.state;
            if (run.status === 'failed') {
              await args.fail(run.error || 'Workflow failed');
            }
            return undefined;
          }
          if (args.kind === 'event') {
            await start(initialInput, { client: args.client, args });
            return undefined;
          }
          args.defer(() => start(initialInput, { client: args.client, args }));
          return trigger.ack ?? `Started *${displayTitle}*…`;
        },
      }));
    }

    return defs;
  }

  return {
    id,
    title: displayTitle,
    start,
    resume,
    cancel,
    getRun,
    listRuns,
    actionId,
    viewId,
    parseCallback,
    renderProgress,
    routes,
  };
}

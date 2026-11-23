/**
 * Route table and matching.
 *
 * A route is (kind, id, module) where id is a string or RegExp and module is
 * a route module ({ default | render, loader?, ErrorBoundary? }).
 *
 * The hard-won rule this encodes: Slack must ALWAYS receive a timely ack,
 * including for interactions no route handles — otherwise users see a ⚠️
 * timeout. Unmatched requests are acked by the app using
 * `unmatchedAckValue()`; the route table itself is the allow-list, derived
 * from what's registered, so nothing can drift.
 */

import { normalizeLogger } from './logger.js';

const KINDS = new Set(['command', 'action', 'view', 'view_closed', 'shortcut', 'options', 'event', 'function']);

/**
 * Declare a route explicitly (escape hatch for ids that can't be filenames,
 * and for programmatic registration).
 *
 * @param {string} kind - command|action|view|view_closed|shortcut|options|event|function
 * @param {string|RegExp} id
 * @param {Object} module - { default | render, loader?, ErrorBoundary? }
 */
export function route(kind, id, module) {
  if (!KINDS.has(kind)) {
    throw new Error(`Unknown route kind '${kind}' (valid: ${[...KINDS].join(', ')})`);
  }
  if (typeof id !== 'string' && !(id instanceof RegExp)) {
    throw new Error(`Route id must be a string or RegExp, got ${typeof id}`);
  }
  validateModule(kind, id, module);
  return { kind, id, module };
}

export function validateModule(kind, id, module) {
  if (!module || typeof module !== 'object') {
    throw new Error(`Route ${kind} '${id}' must be a module object`);
  }
  const handler = module.default ?? module.render;
  if (typeof handler !== 'function') {
    throw new Error(`Route ${kind} '${id}' must export a default handler or render function`);
  }
  for (const optional of ['loader', 'render', 'ErrorBoundary']) {
    if (module[optional] !== undefined && typeof module[optional] !== 'function') {
      throw new Error(`Route ${kind} '${id}' export '${optional}' must be a function`);
    }
  }
}

/**
 * Build a router from route definitions.
 *
 * @param {Object} options
 * @param {Array} options.routes - RouteDefs from route() / loadRoutes()
 * @param {Object} [options.logger]
 * @returns {{ match(kind, id), table }}
 */
export function createRouter({ routes = [], logger: rawLogger } = {}) {
  const logger = normalizeLogger(rawLogger);
  const table = new Map(); // kind → { byId: Map, patterns: [{pattern, def}] }

  for (const kind of KINDS) {
    table.set(kind, { byId: new Map(), patterns: [] });
  }

  for (const def of routes) {
    const bucket = table.get(def.kind);
    if (!bucket) {
      throw new Error(`Unknown route kind '${def.kind}'`);
    }
    if (def.id instanceof RegExp) {
      bucket.patterns.push(def);
    } else {
      if (bucket.byId.has(def.id)) {
        logger.warn({ kind: def.kind, id: def.id }, 'Duplicate route registration; later route wins');
      }
      bucket.byId.set(def.id, def);
    }
  }

  /**
   * Find the route for a normalized SlackRequest. Exact string match wins
   * over patterns; patterns match in registration order.
   * @returns {Object|null} the RouteDef or null
   */
  function match(kind, id) {
    const bucket = table.get(kind);
    if (!bucket) return null;

    const exact = bucket.byId.get(id);
    if (exact) return exact;

    for (const def of bucket.patterns) {
      if (def.id.test(id)) return def;
    }
    return null;
  }

  return { match, table };
}

/**
 * The ack value for an unmatched request. Options responses must be a valid
 * (empty) options body; everything else acks empty.
 */
export function unmatchedAckValue(kind) {
  return kind === 'options' ? { options: [] } : undefined;
}

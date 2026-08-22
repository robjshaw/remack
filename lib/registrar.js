'use strict';

/**
 * Handler registrar.
 *
 * Structures a bot as handler modules instead of one giant function of
 * inline closures, and derives the "known handler" set automatically so the
 * catch-all fallbacks never need a hand-maintained allow-list (a pattern
 * that breaks silently the first time someone forgets to update the list).
 *
 * A handler module is: { name: string, register(r, deps) }
 *
 *   const pingModule = {
 *     name: 'ping',
 *     register(r, deps) {
 *       r.command('/ping', async ({ ack }) => { await ack('pong'); });
 *       r.action('ping_button', async ({ ack }) => { await ack(); });
 *     },
 *   };
 *
 * Every registration is wrapped with the central error handler (when
 * provided) and recorded; `finalize()` installs catch-all action/view/event
 * fallbacks that ack anything not recorded, so Slack always gets a timely
 * acknowledgement.
 */

const { ackSafely } = require('./helpers');
const { normalizeLogger } = require('./logger');

const KINDS = ['command', 'action', 'view', 'event', 'shortcut', 'options', 'message'];

function matchesRegistered(registered, id) {
  if (!id) return false;
  if (registered.ids.has(id)) return true;
  return registered.patterns.some((pattern) => pattern.test(id));
}

/**
 * Create a registrar bound to a Bolt app.
 *
 * @param {Object} app - Bolt App
 * @param {Object} [options]
 * @param {Object} [options.logger] - pino-like logger
 * @param {Object} [options.deps] - Dependencies passed to each module's register()
 * @param {{wrap: Function}} [options.errorHandler] - From createErrorHandler
 * @returns {{ use: Function, finalize: Function, registered: Object }}
 */
function createRegistrar(app, { logger: rawLogger, deps = {}, errorHandler } = {}) {
  const logger = normalizeLogger(rawLogger);

  // Per kind: string ids + RegExp patterns registered by modules
  const registered = {};
  for (const kind of KINDS) {
    registered[kind] = { ids: new Set(), patterns: [] };
  }

  let finalized = false;

  function record(kind, id, moduleName) {
    const bucket = registered[kind];
    if (id instanceof RegExp) {
      bucket.patterns.push(id);
    } else if (typeof id === 'string') {
      if (bucket.ids.has(id)) {
        logger.warn({ kind, id, module: moduleName }, 'Duplicate Slack handler registration');
      }
      bucket.ids.add(id);
    }
  }

  function buildModuleApi(moduleName) {
    const api = {};

    for (const kind of KINDS) {
      api[kind] = (id, ...middleware) => {
        if (finalized) {
          throw new Error(`Cannot register ${kind} '${id}' after finalize()`);
        }

        record(kind, id, moduleName);

        const handler = middleware[middleware.length - 1];
        const wrapped = errorHandler
          ? errorHandler.wrap(handler, { module: moduleName, kind, id: String(id) })
          : handler;

        app[kind](id, ...middleware.slice(0, -1), wrapped);
      };
    }

    return api;
  }

  /**
   * Register a handler module: { name, register(r, deps) }.
   */
  function use(module) {
    if (!module || typeof module.register !== 'function') {
      throw new Error('Handler module must be an object with a register(r, deps) function');
    }

    const name = module.name || 'anonymous';
    logger.debug({ module: name }, 'Registering Slack handler module');
    module.register(buildModuleApi(name), deps);
    return registrar;
  }

  /**
   * Install catch-all fallbacks so Slack always receives a timely ack for
   * interactions no module handles. Call after every use().
   *
   * @param {Object} [options]
   * @param {boolean} [options.fallbackAck] - Install the fallbacks (default true)
   */
  function finalize({ fallbackAck = true } = {}) {
    finalized = true;
    if (!fallbackAck) return registrar;

    // Unhandled block actions
    app.action(/.*/, async ({ ack, body, next }) => {
      const actionIds = Array.isArray(body?.actions)
        ? body.actions.map((action) => action.action_id).filter(Boolean)
        : [];

      if (actionIds.some((id) => matchesRegistered(registered.action, id))) {
        // A dedicated handler owns this action
        return next();
      }

      const acknowledged = await ackSafely(ack, undefined, {
        logger,
        actionType: body?.type,
        actionIds,
      });
      if (acknowledged) {
        logger.info({ actionType: body?.type, actionIds }, 'Unhandled Slack action acknowledged');
      }
    });

    // Unhandled view submissions/closes
    app.view(/.*/, async ({ ack, body, view, next }) => {
      const callbackId = view?.callback_id || body?.view?.callback_id;

      if (matchesRegistered(registered.view, callbackId)) {
        return next();
      }

      const acknowledged = await ackSafely(ack, undefined, { logger, callbackId });
      if (acknowledged) {
        logger.info({ callbackId }, 'Unhandled Slack view acknowledged');
      }
    });

    // Unhandled events (not all events have an ack function)
    app.event(/.*/, async ({ ack, event }) => {
      const acknowledged = await ackSafely(ack, undefined, {
        logger,
        eventType: event?.type,
        eventSubtype: event?.subtype,
      });

      if (acknowledged) {
        logger.info({ eventType: event?.type, eventSubtype: event?.subtype }, 'Unhandled Slack event acknowledged');
      } else {
        logger.debug({ eventType: event?.type }, 'Slack event does not require acknowledgement or was already handled');
      }
    });

    return registrar;
  }

  const registrar = { use, finalize, registered };
  return registrar;
}

module.exports = { createRegistrar };

'use strict';

/**
 * Logger normalization.
 *
 * Every boltkit factory accepts an optional `logger` option. Any pino-like
 * logger works: an object with `debug/info/warn/error(obj, msg)` methods
 * (message-only calls are fine too). When no logger is supplied, a thin
 * console-backed fallback is used so the library never requires a logging
 * dependency.
 *
 * Debug output from the console fallback is suppressed unless the
 * BOLTKIT_DEBUG environment variable is set.
 */

const LEVELS = ['debug', 'info', 'warn', 'error'];

function isLoggerLike(logger) {
  return !!logger && LEVELS.every((level) => typeof logger[level] === 'function');
}

function consoleMethod(level) {
  if (level === 'debug') return console.debug.bind(console);
  if (level === 'warn') return console.warn.bind(console);
  if (level === 'error') return console.error.bind(console);
  return console.info.bind(console);
}

function buildConsoleLogger(bindings = {}) {
  const logger = {};

  for (const level of LEVELS) {
    logger[level] = (objOrMsg, maybeMsg) => {
      if (level === 'debug' && !process.env.BOLTKIT_DEBUG) return;

      const write = consoleMethod(level);
      if (typeof objOrMsg === 'string') {
        write(objOrMsg, ...(Object.keys(bindings).length ? [bindings] : []));
      } else {
        const context = { ...bindings, ...(objOrMsg || {}) };
        write(maybeMsg || '', ...(Object.keys(context).length ? [context] : []));
      }
    };
  }

  logger.child = (childBindings = {}) => buildConsoleLogger({ ...bindings, ...childBindings });

  return logger;
}

/**
 * Return the given logger if it quacks like a logger, otherwise a
 * console-backed fallback.
 *
 * @param {object} [logger] - pino-like logger
 * @returns {object} logger with debug/info/warn/error and child()
 */
function normalizeLogger(logger) {
  return isLoggerLike(logger) ? logger : buildConsoleLogger();
}

module.exports = { normalizeLogger };

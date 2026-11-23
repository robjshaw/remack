/**
 * Logger normalization.
 *
 * Every remack factory accepts an optional `logger` option. Any pino-like
 * logger works: an object with `debug/info/warn/error(obj, msg)` methods
 * (message-only calls are fine too). When no logger is supplied, a thin
 * console-backed fallback is used so the library never requires a logging
 * dependency.
 *
 * Debug output from the console fallback is suppressed unless the
 * REMACK_DEBUG environment variable is set.
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
      if (level === 'debug' && !globalThis.process?.env?.REMACK_DEBUG) return;

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
export function normalizeLogger(logger) {
  return isLoggerLike(logger) ? logger : buildConsoleLogger();
}

/**
 * Bind fields to every line a logger writes. Uses the logger's own
 * child() when it has one (pino, the console fallback); otherwise wraps
 * the level methods so bindings are never silently dropped.
 *
 * @param {object} logger - normalized logger
 * @param {object} bindings - fields merged into every log object
 * @returns {object} logger with debug/info/warn/error and child()
 */
export function childLogger(logger, bindings) {
  if (typeof logger.child === 'function') return logger.child(bindings);

  const child = {};
  for (const level of LEVELS) {
    child[level] = (objOrMsg, maybeMsg) => (typeof objOrMsg === 'string'
      ? logger[level](bindings, objOrMsg)
      : logger[level]({ ...bindings, ...(objOrMsg || {}) }, maybeMsg));
  }
  child.child = (more = {}) => childLogger(logger, { ...bindings, ...more });
  return child;
}

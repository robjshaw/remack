'use strict';

/** Shared test doubles for boltkit tests. */

/**
 * Fake pg pool: records query(text, params) calls and returns scripted rows.
 * Pass an array of results (consumed in order) or a function (text, params) => {rows}.
 */
function fakePool(script = []) {
  const calls = [];
  const scriptFn = typeof script === 'function' ? script : null;
  const queue = scriptFn ? null : [...script];

  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (scriptFn) return scriptFn(text, params);
      const next = queue.length ? queue.shift() : { rows: [] };
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/**
 * Fake Bolt app: records registrations per kind and can dispatch a payload
 * to every matching listener (like Bolt runs all matching listeners).
 */
function fakeBoltApp() {
  const registrations = { command: [], action: [], view: [], event: [], shortcut: [], options: [], message: [], error: [] };

  const app = {};
  for (const kind of Object.keys(registrations)) {
    if (kind === 'error') continue;
    app[kind] = (id, ...middleware) => {
      registrations[kind].push({ id, handlers: middleware });
    };
  }
  app.error = (handler) => registrations.error.push({ handlers: [handler] });

  function matches(registeredId, id) {
    if (registeredId instanceof RegExp) return registeredId.test(id);
    return registeredId === id;
  }

  /** Invoke all listeners of `kind` whose id matches, with the given args. */
  async function dispatch(kind, id, args) {
    const matching = registrations[kind].filter((r) => matches(r.id, id));
    for (const reg of matching) {
      // Run the middleware chain: each gets args plus next()
      let index = 0;
      const run = async () => {
        const handler = reg.handlers[index++];
        if (!handler) return;
        await handler({ ...args, next: run });
      };
      await run();
    }
    return matching.length;
  }

  return { app, registrations, dispatch };
}

/** Fake WebClient with recordable nested method stubs. */
function fakeWebClient(overrides = {}) {
  const calls = [];

  function stub(path, defaultResult) {
    return async (params) => {
      calls.push({ method: path, params });
      const override = overrides[path];
      if (override instanceof Error) throw override;
      if (typeof override === 'function') return override(params);
      return override ?? defaultResult;
    };
  }

  return {
    calls,
    conversations: { open: stub('conversations.open', { channel: { id: 'D_FAKE' } }) },
    files: { uploadV2: stub('files.uploadV2', { ok: true }) },
    chat: {
      postMessage: stub('chat.postMessage', { ok: true }),
      postEphemeral: stub('chat.postEphemeral', { ok: true }),
    },
    users: {
      lookupByEmail: stub('users.lookupByEmail', { ok: true, user: { id: 'U_FAKE', real_name: 'Fake User', profile: {} } }),
      info: stub('users.info', { ok: true, user: { id: 'U_FAKE', real_name: 'Fake User', profile: {} } }),
    },
  };
}

/** Silent logger that records calls. */
function fakeLogger() {
  const entries = [];
  const make = (level) => (objOrMsg, msg) => entries.push({ level, objOrMsg, msg });
  return {
    entries,
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child: () => fakeLogger(),
  };
}

module.exports = { fakePool, fakeBoltApp, fakeWebClient, fakeLogger };

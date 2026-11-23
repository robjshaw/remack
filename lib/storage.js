/**
 * Storage — remack's one persistence primitive.
 *
 * Everything that needs to remember something (OAuth installations, feature
 * access, engagement events) speaks this tiny namespaced-KV contract:
 *
 *   {
 *     get(ns, key)                     → value | null
 *     put(ns, key, value)              → void      (value: JSON-serializable)
 *     delete(ns, key)                  → void
 *     list(ns, {prefix?, limit?} = {}) → [{key, value}]  (sorted by key)
 *   }
 *
 * Two zero-dependency implementations ship in core:
 *   memoryStorage() — the default; perfect for dev and single-token bots
 *   fileStorage(path) — one JSON file; survives restarts on a single instance
 *
 * For production multi-instance apps, implement the same four methods over
 * your datastore — or use the Postgres adapter at ext/postgres-storage.js
 * (one table, one migration).
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

function sortedEntries(map, { prefix, limit } = {}) {
  let keys = [...map.keys()].sort();
  if (prefix) keys = keys.filter((key) => key.startsWith(prefix));
  if (limit !== undefined) keys = keys.slice(0, limit);
  return keys.map((key) => ({ key, value: map.get(key) }));
}

/** In-memory storage. State lives for the process lifetime. */
export function memoryStorage() {
  const namespaces = new Map();

  const ns = (name) => {
    if (!namespaces.has(name)) namespaces.set(name, new Map());
    return namespaces.get(name);
  };

  return {
    async get(name, key) {
      const value = ns(name).get(key);
      return value === undefined ? null : structuredClone(value);
    },
    async put(name, key, value) {
      ns(name).set(key, structuredClone(value));
    },
    async delete(name, key) {
      ns(name).delete(key);
    },
    async list(name, options) {
      return sortedEntries(ns(name), options).map(({ key, value }) => ({ key, value: structuredClone(value) }));
    },
  };
}

/**
 * Single-JSON-file storage. Writes are serialized and atomic (temp file +
 * rename), reads come from an in-memory mirror loaded on first use. Fine for
 * one instance; use a real datastore for multi-instance deployments.
 *
 * @param {string|URL} path - e.g. './data/remack.json'
 */
export function fileStorage(path) {
  const filePath = path instanceof URL ? path.pathname : path;
  let namespaces = null;
  let writeChain = Promise.resolve();

  async function load() {
    if (namespaces) return namespaces;
    namespaces = new Map();
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8'));
      for (const [name, entries] of Object.entries(raw)) {
        namespaces.set(name, new Map(Object.entries(entries)));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return namespaces;
  }

  function persist() {
    writeChain = writeChain.then(async () => {
      const snapshot = {};
      for (const [name, entries] of namespaces) {
        snapshot[name] = Object.fromEntries(entries);
      }
      await mkdir(dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.tmp`;
      await writeFile(tempPath, JSON.stringify(snapshot, null, 2));
      await rename(tempPath, filePath);
    });
    return writeChain;
  }

  const ns = async (name) => {
    const all = await load();
    if (!all.has(name)) all.set(name, new Map());
    return all.get(name);
  };

  return {
    async get(name, key) {
      const value = (await ns(name)).get(key);
      return value === undefined ? null : value;
    },
    async put(name, key, value) {
      (await ns(name)).set(key, value);
      await persist();
    },
    async delete(name, key) {
      (await ns(name)).delete(key);
      await persist();
    },
    async list(name, options) {
      return sortedEntries(await ns(name), options);
    },
  };
}

const NAMESPACE_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Scope a storage to one app: every namespace becomes `{prefix}:{ns}`.
 * Lets several remack apps (or an app and your own code) share one
 * backing store without their installations or feature flags colliding.
 *
 * @param {Object} storage - any storage implementing the four-method contract
 * @param {string} prefix - [A-Za-z0-9_.-]+
 */
export function namespacedStorage(storage, prefix) {
  if (typeof prefix !== 'string' || !NAMESPACE_PATTERN.test(prefix)) {
    throw new Error(`storage namespace must match ${NAMESPACE_PATTERN} (got ${JSON.stringify(prefix)})`);
  }
  const scoped = (name) => `${prefix}:${name}`;

  return {
    get: (name, key) => storage.get(scoped(name), key),
    put: (name, key, value) => storage.put(scoped(name), key, value),
    delete: (name, key) => storage.delete(scoped(name), key),
    list: (name, options) => storage.list(scoped(name), options),
  };
}

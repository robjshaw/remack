/**
 * File-based route discovery — religiously runtime: a flat fs scan plus
 * dynamic import(), no build step, no manifest.
 *
 * Filename convention: `{kind}.{id}.js` — the first dot-segment is the
 * route kind, everything after it (dots preserved) is the id.
 *
 *   command.report.js          → command /report
 *   action.open_settings.js    → block_actions action_id 'open_settings'
 *   action.row_$.js            → action_id matching /^row_.*$/  ($ = wildcard)
 *   view.settings.js           → view_submission callback_id 'settings'
 *   view_closed.settings.js    → view_closed callback_id
 *   shortcut.new_task.js       → shortcut callback_id
 *   options.project_picker.js  → block_suggestion action_id
 *   event.app_home_opened.js   → event type
 *   function.prep_step.js      → custom workflow step callback_id
 *
 * Ids that can't be expressed as filenames register explicitly with
 * route(kind, idOrRegExp, module) instead.
 */

import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { route } from './router.js';
import { normalizeLogger } from './logger.js';

const KIND_PREFIXES = ['view_closed', 'command', 'action', 'view', 'shortcut', 'options', 'event', 'function'];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a route filename into { kind, id }. Returns null for non-route files.
 */
export function parseRouteFilename(filename) {
  if (!filename.endsWith('.js') && !filename.endsWith('.mjs')) return null;
  const base = filename.replace(/\.m?js$/, '');

  // view_closed contains the separator, so match known prefixes explicitly
  const kind = KIND_PREFIXES.find((prefix) => base.startsWith(`${prefix}.`));
  if (!kind) return null;

  let id = base.slice(kind.length + 1);
  if (!id) return null;

  if (kind === 'command' && !id.startsWith('/')) {
    id = `/${id}`;
  }

  if (id.includes('$')) {
    const pattern = id.split('$').map(escapeRegExp).join('.*');
    return { kind, id: new RegExp(`^${pattern}$`) };
  }

  return { kind, id };
}

/**
 * Discover routes in a directory.
 *
 * @param {string|URL} dir - Directory containing route files
 * @param {Object} [options]
 * @param {Object} [options.logger]
 * @returns {Promise<Array>} RouteDefs for createRouter()
 */
export async function loadRoutes(dir, { logger: rawLogger } = {}) {
  const logger = normalizeLogger(rawLogger);
  const dirPath = dir instanceof URL ? dir.pathname : dir;

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read routes directory '${dirPath}': ${error.message}`);
  }

  const defs = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;

    const parsed = parseRouteFilename(entry.name);
    if (!parsed) {
      if (/\.m?js$/.test(entry.name)) {
        logger.warn({ file: entry.name }, 'Skipping file that does not match the {kind}.{id}.js convention');
      }
      continue;
    }

    const fileUrl = pathToFileURL(join(dirPath, entry.name)).href;
    let module;
    try {
      module = await import(fileUrl);
    } catch (error) {
      throw new Error(`Failed to import route file '${entry.name}': ${error.message}`);
    }

    try {
      defs.push(route(parsed.kind, parsed.id, module));
    } catch (error) {
      throw new Error(`Invalid route module '${entry.name}': ${error.message}`);
    }

    logger.debug({ file: entry.name, kind: parsed.kind, id: String(parsed.id) }, 'Registered route');
  }

  return defs;
}

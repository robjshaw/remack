/**
 * routes — show the route table for this bot.
 *
 * The table is derived from filenames; each module is also imported (best
 * effort) to show which exports it provides. Import failures don't break
 * the listing — the file is shown with the error instead.
 */

import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { scanRoutes } from './manifest.js';

export async function run(argv, { stdout }) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string', default: 'routes' },
    },
  });

  const dir = resolve(values.dir);
  const routes = await scanRoutes(dir);

  if (routes.length === 0) {
    stdout.write(`No route files found in ${dir}.\nName files {kind}.{id}.js — e.g. command.ping.js, event.app_home_opened.js\n`);
    return 1;
  }

  const rows = [];
  for (const { file, parsed } of routes) {
    let exports = '';
    try {
      const module = await import(pathToFileURL(join(dir, file)).href);
      exports = ['default', 'loader', 'render', 'ErrorBoundary']
        .filter((name) => typeof module[name] === 'function')
        .join(', ') || '(no handler exports!)';
    } catch (error) {
      exports = `import failed: ${error.message.split('\n')[0]}`;
    }
    rows.push({ kind: parsed.kind, id: String(parsed.id), file, exports });
  }

  const kindWidth = Math.max(4, ...rows.map((row) => row.kind.length));
  const idWidth = Math.max(2, ...rows.map((row) => row.id.length));

  stdout.write(`${'KIND'.padEnd(kindWidth)}  ${'ID'.padEnd(idWidth)}  EXPORTS  (${dir})\n`);
  for (const row of rows) {
    stdout.write(`${row.kind.padEnd(kindWidth)}  ${row.id.padEnd(idWidth)}  ${row.exports}\n`);
  }
  return 0;
}

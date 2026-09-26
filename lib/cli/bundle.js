/**
 * A deliberately tiny ESM → single-script bundler for slackline's own lib/
 * code, used to ship the Apps Script adapter (Apps Script has no modules).
 *
 * It understands exactly the style lib/ is written in and refuses anything
 * else, rather than guessing:
 *   import { a, b as c } from './x.js';        (relative, named only)
 *   export function|async function|class|const|let f …
 *   export { a, b as c } from './x.js';
 * Each module becomes a function in a registry; the entry's exports are
 * returned as one global object. Zero dependencies, no AST — lib/ stays
 * simple enough that this is enough.
 */

import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm;
const REEXPORT_RE = /^export\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm;
const DECL_EXPORT_RE = /^export\s+((?:async\s+)?function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;

function specifiers(list) {
  return list.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [imported, local = imported] = part.split(/\s+as\s+/).map((name) => name.trim());
    return { imported, local };
  });
}

function unsupported(file, what) {
  return new Error(`bundle: ${file} uses ${what}, which the Apps Script bundler does not support`);
}

async function transformModule(file, root) {
  const source = await readFile(file, 'utf8');
  const id = relative(root, file);
  const deps = [];
  const exportNames = []; // [exported, local]
  const resolveDep = (spec) => {
    if (!spec.startsWith('.')) throw unsupported(id, `a non-relative import ('${spec}')`);
    const depFile = resolve(dirname(file), spec);
    deps.push(depFile);
    return relative(root, depFile);
  };

  let code = source.replace(IMPORT_RE, (_, list, spec) => {
    const depId = resolveDep(spec);
    const bindings = specifiers(list).map(({ imported, local }) =>
      (imported === local ? local : `${imported}: ${local}`));
    return `const { ${bindings.join(', ')} } = __require(${JSON.stringify(depId)});`;
  });

  let reexportCount = 0;
  code = code.replace(REEXPORT_RE, (_, list, spec) => {
    const depId = resolveDep(spec);
    const tmp = `__reexport${reexportCount++}`;
    for (const { imported, local } of specifiers(list)) exportNames.push([local, `${tmp}.${imported}`]);
    return `const ${tmp} = __require(${JSON.stringify(depId)});`;
  });

  code = code.replace(/^export\s*\{([^}]*)\};?[ \t]*$/gm, (_, list) => {
    for (const { imported, local } of specifiers(list)) exportNames.push([local, imported]);
    return '';
  });

  code = code.replace(DECL_EXPORT_RE, (_, keyword, name) => {
    exportNames.push([name, name]);
    return `${keyword} ${name}`;
  });

  for (const [pattern, what] of [
    [/^import\s/m, 'an import form other than `import { … } from`'],
    [/^export\s/m, 'an export form other than declarations or `export { … }`'],
    [/\bimport\s*\(/, 'dynamic import()'],
    [/\bimport\.meta\b/, 'import.meta'],
  ]) {
    if (pattern.test(code)) throw unsupported(id, what);
  }

  const exportsObject = exportNames.map(([exported, local]) => `${JSON.stringify(exported)}: ${local}`);
  return {
    id,
    deps,
    wrapped: `__defs[${JSON.stringify(id)}] = function (__require) {\n${code.trimEnd()}\n`
      + `return { ${exportsObject.join(', ')} };\n};`,
  };
}

/**
 * Bundle `entry` and its relative imports into one script that defines
 * `var <globalName>` holding the entry's exports.
 *
 * @param {Object} options
 * @param {string} options.entry - absolute path of the entry module
 * @param {string} options.root - ids are paths relative to this
 * @param {string} options.globalName
 * @param {string} [options.banner]
 * @returns {Promise<string>}
 */
export async function bundle({ entry, root, globalName, banner = '' }) {
  const modules = new Map();
  const queue = [resolve(entry)];
  while (queue.length) {
    const file = queue.shift();
    if (modules.has(file)) continue;
    const mod = await transformModule(file, root);
    modules.set(file, mod);
    queue.push(...mod.deps);
  }

  const entryId = relative(root, resolve(entry));
  const body = [...modules.values()].map((mod) => mod.wrapped).join('\n\n');

  return `${banner}var ${globalName} = (function () {
'use strict';
var __defs = {};
var __cache = {};
function __require(id) {
  if (!(id in __cache)) {
    if (!(id in __defs)) throw new Error('slackline bundle: missing module ' + id);
    __cache[id] = null; // cycle guard
    __cache[id] = __defs[id](__require);
  }
  return __cache[id];
}

${body}

return __require(${JSON.stringify(entryId)});
})();
`;
}

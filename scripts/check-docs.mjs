import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Scope is maintained documentation, not historical reports or private plans.
export async function checkDocs(root) {
  const docs = ['README.md', 'ARCHITECTURE.md', 'DEPLOYMENT.md', 'AGENTS.md'];
  async function collect(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.name.endsWith('.md')) docs.push(path);
    }
  }
  await collect('docs');
  const { scripts = {} } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const errors = [];
  async function exists(path) {
    try { await stat(path); return true; }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
  }
  for (const file of docs) {
    const source = await readFile(join(root, file), 'utf8');
    // Ignore fenced examples for Markdown links; npm commands are checked in examples too.
    const prose = source.replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm, '');
    const links = [...prose.matchAll(/\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g)].map(match => match[1]);
    // Reference-style destinations: [label]: path "optional title".
    links.push(...[...prose.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>]+>|\S+)/gm)].map(match => match[1]));
    for (const raw of links) {
      const target = raw.replace(/^<|>$/g, '');
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
      let path;
      try { path = decodeURIComponent(target.split(/[?#]/)[0]); }
      catch { errors.push(`${file}: invalid URL encoding: ${target}`); continue; }
      if (!path) continue;
      const absolute = path.startsWith('/') ? resolve(root, `.${path}`) : resolve(root, dirname(file), path);
      if (!await exists(absolute)) errors.push(`${file}: missing link target: ${target}`);
    }
    for (const match of prose.matchAll(/`(src\/[^`]+\.(?:tsx?|css))`/g)) {
      if (!await exists(resolve(root, match[1]))) errors.push(`${file}: missing source file: ${match[1]}`);
    }
    for (const match of source.matchAll(/\bnpm run ([\w:-]+)/g)) {
      if (!Object.hasOwn(scripts, match[1])) errors.push(`${file}: unknown npm script: ${match[1]}`);
    }
  }
  return { files: docs.length, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    const result = await checkDocs(root);
    if (result.errors.length) {
      console.error(result.errors.join('\n'));
      process.exitCode = 1;
    } else console.log(`Documentation checks passed (${result.files} files).`);
  } catch (error) { console.error(error); process.exitCode = 1; }
}

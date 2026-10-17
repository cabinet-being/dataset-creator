import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocs } from '../scripts/check-docs.mjs';

test('documentation checker detects broken references without treating examples or external URLs as files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'docs-checker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs/nested'), { recursive: true });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', 'test:ci': 'test' } }));
  for (const file of ['README.md', 'ARCHITECTURE.md', 'DEPLOYMENT.md', 'AGENTS.md']) await writeFile(join(root, file), '# Documentation\n');
  await writeFile(join(root, 'src/existing.ts'), '');
  await writeFile(join(root, 'docs/a file.md'), '# A file\n');
  await writeFile(join(root, 'docs/nested/guide.md'), [
    '[Home](../../README.md#intro)', '[Space](../a%20file.md)', '[Angle](<../a file.md>)',
    '[External](https://example.com/missing)', '[Email](mailto:test@example.com)', '[Local](#section)',
    '[Reference][home]', '[home]: ../../README.md "Home"',
    '`src/existing.ts`', '```bash', 'npm run build', 'npm run test:ci', '```',
    '```md', '[Example](not-a-real-file)', '```',
  ].join('\n'));
  assert.deepEqual((await checkDocs(root)).errors, []);
  await writeFile(join(root, 'docs/nested/broken.md'), [
    '[Missing](missing.md)', '[ref]: absent.md', '`src/deleted.ts`',
    '```bash', 'npm run missing:script', '```', '[Invalid](%ZZ.md)',
  ].join('\n'));
  const { errors } = await checkDocs(root);
  assert.equal(errors.length, 5, errors.join('\n'));
  for (const text of ['missing.md', 'absent.md', 'src/deleted.ts', 'missing:script', 'invalid URL encoding']) {
    assert.ok(errors.some(error => error.includes(text)), text);
  }
});

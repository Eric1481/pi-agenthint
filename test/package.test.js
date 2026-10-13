import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('manifest is a discoverable standalone Pi package', () => {
  assert.equal(manifest.name, 'pi-agenthint');
  assert.equal(manifest.description, 'Agent Hint request metadata and lifecycle reporting for Pi');
  assert.doesNotMatch(manifest.description, /v2/i);
  assert.equal(manifest.homepage, 'https://github.com/Eric1481/pi-agenthint#readme');
  assert.deepEqual(manifest.repository, {
    type: 'git',
    url: 'git+https://github.com/Eric1481/pi-agenthint.git',
  });
  assert.equal(manifest.bugs.url, 'https://github.com/Eric1481/pi-agenthint/issues');
  assert.ok(manifest.keywords.includes('pi-package'));
  assert.deepEqual(manifest.pi.extensions, ['./src/extension.js']);
  assert.equal(manifest.peerDependencies['@earendil-works/pi-coding-agent'], '*');
  assert.equal(manifest.dependencies, undefined);
  assert.match(manifest.scripts['test:e2e'], /test\/e2e/);
});

test('package carries the approved Apache-2.0 license', () => {
  assert.equal(manifest.license, 'Apache-2.0');
  assert.ok(manifest.files.includes('LICENSE'));
  assert.match(readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'), /Apache License/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('manifest is a discoverable standalone Pi package', () => {
  assert.equal(manifest.name, 'pi-agenthint');
  assert.ok(manifest.keywords.includes('pi-package'));
  assert.deepEqual(manifest.pi.extensions, ['./src/extension.js']);
  assert.equal(manifest.peerDependencies['@earendil-works/pi-coding-agent'], '*');
  assert.equal(manifest.dependencies, undefined);
});

test('package carries the approved Apache-2.0 license', () => {
  assert.equal(manifest.license, 'Apache-2.0');
  assert.ok(manifest.files.includes('LICENSE'));
  assert.match(readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'), /Apache License/);
});

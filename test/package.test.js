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

test('package does not claim an unapproved open-source license', () => {
  assert.equal(manifest.license, 'UNLICENSED');
});

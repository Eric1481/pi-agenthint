import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError, DEFAULT_CONFIG, parseConfig, resolveConfig } from '../src/config.js';

test('dedicated package defaults to in-band hints on and external reporting off', () => {
  const config = parseConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.agentType, 'pi-agent');
  assert.equal(config.reporting.enabled, false);
  assert.equal(config.reporting.endpoint, '');
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test('configuration rejects unknown fields and implicit coercion', () => {
  assert.throws(() => parseConfig({ enable: true }),
    (error) => error instanceof ConfigError && error.path === 'enable');
  assert.throws(() => parseConfig({ enabled: 'yes' }),
    (error) => error instanceof ConfigError && error.path === 'enabled');
  assert.throws(() => parseConfig({ reporting: { url: 'https://example.test' } }),
    (error) => error instanceof ConfigError && error.path === 'reporting.url');
});

test('reporting requires an explicit http endpoint', () => {
  assert.throws(() => parseConfig({ reporting: { enabled: true } }),
    (error) => error instanceof ConfigError && error.path === 'reporting.endpoint');
  assert.throws(() => parseConfig({ reporting: { endpoint: 'file:///tmp/hints' } }), /http\(s\)/);
  assert.equal(parseConfig({ reporting: {
    enabled: true,
    endpoint: 'http://collector.test/hints',
  } }).reporting.endpoint, 'http://collector.test/hints');
});

test('invalid explicit configuration fails closed instead of enabling defaults', () => {
  const result = resolveConfig({
    env: { PI_AGENTHINT_CONFIG: 'broken.json' },
    readFile: () => '{"enabled":"yes"}',
  });
  assert.equal(result.source, 'broken.json');
  assert.equal(result.config.enabled, false);
  assert.match(result.error, /enabled/);
});

test('config path is the only external behavior source', () => {
  const result = resolveConfig({ env: {
    ASCEND_HINT_AGENT_TYPE: 'legacy',
    PI_SUBAGENT_RUN_ID: 'child',
  } });
  assert.equal(result.source, 'defaults');
  assert.equal(result.config.agentType, 'pi-agent');
});

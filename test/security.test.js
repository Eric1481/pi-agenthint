import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseConfig } from '../src/config.js';
import { createAgentHintExtension } from '../src/extension.js';
import { createStatusReporter } from '../src/hint-control.js';

test('reporting token is resolved for each delivery and never retained in state', async () => {
  let token = 'first';
  const seen = [];
  const reporter = createStatusReporter({
    enabled: true,
    endpoint: 'https://collector.test/hints',
    token: () => token,
    fetchImpl: async (_url, init) => {
      seen.push(init.headers.authorization);
      return { ok: true, status: 200 };
    },
  });
  reporter.send({ agent_status: { state: 'running' } });
  await reporter.flush();
  token = 'second';
  reporter.send({ agent_status: { state: 'finalize' } });
  await reporter.flush();
  assert.deepEqual(seen, ['Bearer first', 'Bearer second']);
  assert.doesNotMatch(JSON.stringify(reporter.state()), /first|second/);
});

test('session shutdown allows the final status event to drain', async () => {
  const events = [];
  const handlers = new Map();
  createAgentHintExtension({
    config: parseConfig({
      reporting: { enabled: true, endpoint: 'https://collector.test/hints' },
    }),
    env: {},
    now: () => 1000,
    statusFetch: async (_url, init) => {
      events.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    },
  })({
    registerCommand() {},
    on(name, handler) { handlers.set(name, handler); },
    appendEntry() {},
  });
  const ctx = {
    mode: 'rpc',
    ui: { notify() {} },
    sessionManager: {
      getSessionId: () => 'security-session',
      getEntries: () => [],
    },
  };
  handlers.get('session_start')({ reason: 'new' }, ctx);
  handlers.get('session_shutdown')();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(events.some((event) => event.agent_status?.state === 'finalize'));
});

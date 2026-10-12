/**
 * Tests for the trusted control-plane binding and the out-of-band status channel.
 *
 * Two claims matter here. First, the hard priority is *forwarded*, never derived: a plugin that
 * invented `strict_priority` would hand every agent the power to preempt the queue it competes
 * for. Second, the reporting channel is off unless an endpoint is configured, and when it is off
 * it must not pretend otherwise -- "no events were sent" and "events were sent and accepted" are
 * different states, and only one of them is a basis for trusting the scheduler.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = root;
const { createStatusReporter, parseStrictPriority, resolveStrictPriority } = await import(
  pathToFileURL(join(pluginRoot, 'src', 'hint-control.js')).href
);

test('a strict priority binding is level and reason', () => {
  assert.deepEqual(parseStrictPriority('3:critical_path'), { level: 3, reason: 'critical_path' });
  assert.deepEqual(parseStrictPriority(' 0 '), { level: 0 });
  assert.deepEqual(parseStrictPriority('2:user:waiting'), { level: 2, reason: 'user:waiting' });
});

test('a malformed binding is refused instead of coerced', () => {
  // A partially understood hard priority is worse than none: the engine would act on a number
  // nobody meant.
  assert.equal(parseStrictPriority('high'), undefined);
  assert.equal(parseStrictPriority('99:critical_path'), undefined);
  assert.equal(parseStrictPriority('-1'), undefined);
  assert.equal(parseStrictPriority('1.5'), undefined);
  assert.equal(parseStrictPriority(''), undefined);
  assert.equal(parseStrictPriority(undefined), undefined);
});

test('resolution reports why the field will be absent', () => {
  assert.deepEqual(
    resolveStrictPriority({ raw: '4:user_waiting' }),
    { binding: { level: 4, reason: 'user_waiting' }, reason: 'environment binding' },
  );
  assert.deepEqual(resolveStrictPriority({}), { reason: 'no trusted control plane configured' });
  const refused = resolveStrictPriority({ raw: 'nonsense' });
  assert.equal(refused.binding, undefined);
  assert.match(refused.reason, /refused: expected "<level>:<reason>"/);
  const injected = resolveStrictPriority({ injected: { level: 2, reason: 'critical_path' } });
  assert.deepEqual(injected.binding, { level: 2, reason: 'critical_path' });
  assert.equal(resolveStrictPriority({ injected: { level: 42 } }).binding, undefined);
});

/**
 * @param {object} [options] reporter options.
 * @returns {{ reporter: object, sent: object[], calls: () => number }} a reporter on a fake fetch.
 */
function reporterWithFakeFetch(options = {}) {
  const sent = [];
  const reporter = createStatusReporter({
    enabled: true,
    endpoint: 'http://127.0.0.1:9/hint',
    fetchImpl: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return { ok: true, status: 202 };
    },
    ...options,
  });
  return { reporter, sent, calls: () => sent.length };
}

test('a disabled channel sends nothing and says so', async () => {
  const { reporter, sent } = reporterWithFakeFetch({ enabled: false });
  reporter.send({ session: { session_id: 's' }, agent_status: { state: 'finalize' } });
  await reporter.flush();
  assert.deepEqual(sent, []);
  assert.equal(reporter.state().enabled, false);
  assert.equal(reporter.state().reason, 'reporting disabled');
});

test('an enabled channel without an endpoint refuses to look configured', async () => {
  const { reporter, sent } = reporterWithFakeFetch({ endpoint: '' });
  reporter.send({ agent_status: { state: 'pause' } });
  await reporter.flush();
  assert.deepEqual(sent, [], 'a configured-looking channel that drops everything would be worse than an off one');
  assert.equal(reporter.state().configured, false);
  assert.equal(reporter.state().reason, 'no endpoint configured');
});

test('events reach the collector in the order they were reported', async () => {
  const { reporter, sent } = reporterWithFakeFetch();
  reporter.send({ agent_status: { state: 'tool' } });
  reporter.send({ agent_status: { state: 'running' } });
  reporter.send({ agent_status: { state: 'finalize' } });
  await reporter.flush();
  assert.deepEqual(sent.map((entry) => entry.body.agent_status.state), ['tool', 'running', 'finalize']);
  assert.equal(reporter.state().sent, 3);
  assert.equal(sent[0].headers['content-type'], 'application/json');
});

test('an unchanged state is not re-reported', async () => {
  const { reporter, sent } = reporterWithFakeFetch();
  reporter.send({ agent_status: { state: 'tool' } });
  reporter.send({ agent_status: { state: 'tool' } });
  await reporter.flush();
  assert.equal(sent.length, 1, 're-sending an unchanged state would make ordering assertions meaningless');
});

test('a state may be reported again after an intervening state', async () => {
  const { reporter, sent } = reporterWithFakeFetch();
  reporter.send({ agent_status: { state: 'tool', tools: [{ name: 'task' }] } });
  reporter.send({ agent_status: { state: 'tool', tools: [{ name: 'task' }, { name: 'read' }] } });
  reporter.send({ agent_status: { state: 'tool', tools: [{ name: 'task' }] } });
  await reporter.flush();
  assert.equal(sent.length, 3);
});

test('a failing collector is retried and then counted, never thrown', async () => {
  let attempts = 0;
  const settled = [];
  const reporter = createStatusReporter({
    enabled: true,
    endpoint: 'http://127.0.0.1:9/hint',
    maxRetries: 2,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error('collector unreachable');
    },
    onSettled: (result) => settled.push(result),
  });
  reporter.send({ agent_status: { state: 'finalize' } });
  await reporter.flush();
  assert.equal(attempts, 3, 'one attempt plus two retries');
  assert.equal(reporter.state().failed, 1);
  assert.equal(reporter.state().sent, 0);
  assert.match(reporter.state().lastError, /collector unreachable/);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].ok, false);
});

test('the queue is bounded, dropping the oldest event rather than growing', async () => {
  // The first delivery is held open, which is what lets the queue fill up; every later delivery
  // completes immediately so the test can reach a settled state deterministically.
  /** @type {() => void} */
  let release;
  let calls = 0;
  const reporter = createStatusReporter({
    enabled: true,
    endpoint: 'http://127.0.0.1:9/hint',
    queueLimit: 2,
    fetchImpl: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { release = () => resolve({ ok: true, status: 200 }); });
      return Promise.resolve({ ok: true, status: 200 });
    },
  });
  reporter.send({ agent_status: { state: 'tool' } });
  reporter.send({ agent_status: { state: 'running' } });
  reporter.send({ agent_status: { state: 'pause' } });
  reporter.send({ agent_status: { state: 'finalize' } });
  assert.equal(reporter.state().dropped >= 1, true, 'an advisory channel must not grow without bound');
  assert.ok(reporter.state().queued <= 2, `queued ${reporter.state().queued} events against a limit of 2`);

  release();
  await reporter.flush();
  assert.equal(reporter.state().queued, 0);
  assert.equal(reporter.state().sent, 3, 'one event was in flight, one was dropped, the rest were delivered');
});

test('a token is sent as a bearer header and never enters the recorded state', async () => {
  const { reporter, sent } = reporterWithFakeFetch({ token: 'super-secret' });
  reporter.send({ agent_status: { state: 'running' } });
  await reporter.flush();
  assert.equal(sent[0].headers.authorization, 'Bearer super-secret');
  assert.equal(JSON.stringify(reporter.state()).includes('super-secret'), false, 'status output must not echo secrets');
});

test('a non-http endpoint is treated as unconfigured', async () => {
  const { reporter, sent } = reporterWithFakeFetch({ endpoint: 'file:///tmp/events' });
  reporter.send({ agent_status: { state: 'running' } });
  await reporter.flush();
  assert.deepEqual(sent, []);
  assert.equal(reporter.state().configured, false);
});

test('stopping the channel drops what is queued so a finishing agent can exit', async () => {
  const { reporter, sent } = reporterWithFakeFetch();
  // Hold the first delivery open so the second one is genuinely waiting in the queue.
  /** @type {() => void} */
  let release;
  const held = createStatusReporter({
    enabled: true,
    endpoint: 'http://127.0.0.1:9/hint',
    fetchImpl: () => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200 }); }),
  });
  held.send({ agent_status: { state: 'tool' } });
  held.send({ agent_status: { state: 'running' } });
  held.stop();
  release();
  await held.flush();
  assert.equal(held.state().queued, 0, 'a stopped channel holds nothing that could keep the process alive');

  reporter.send({ agent_status: { state: 'running' } });
  await reporter.flush();
  reporter.stop();
  reporter.send({ agent_status: { state: 'finalize' } });
  await reporter.flush();
  assert.equal(reporter.state().sent, 1, 'an event reported after the stop is not delivered');
});

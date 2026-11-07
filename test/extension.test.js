/**
 * Integration tests for the hint as it leaves the plugin: `X-Agent-Hint` on the provider request.
 *
 * These drive the extension through the same hook sequence Pi uses (`context_with_system` publishes the
 * final conversation, `before_provider_headers` writes the hint, `before_provider_request`
 * exposes the provider payload) and assert on the header, not on the builder's internals -- the
 * question they answer is "what does another process see?", which is the only question a wire
 * protocol has to get right. The real-HTTP version is in tests/hint.wire.test.js.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { CURRENT_SESSION_VERSION } from '@earendil-works/pi-coding-agent';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = root;
const { createAgentHintExtension } = await import(pathToFileURL(join(pluginRoot, 'src', 'index.js')).href);
const { parseConfig } = await import(pathToFileURL(join(pluginRoot, 'src', 'config.js')).href);
const { decodeAgentHint } = await import(pathToFileURL(join(pluginRoot, 'src', 'hint-build.js')).href);
const { validateAgentHint } = await import(pathToFileURL(join(pluginRoot, 'src', 'hint-schema.js')).href);

const SESSION_ID = 'sess-hint-header';

/**
 * Long enough to clear the one-block minimum (128 estimated tokens): the declaration path is only
 * meaningful for prefixes the engine can actually store, so the shared fixture has to look like a
 * real prompt rather than a three-word stub.
 */
const LONG_SYSTEM_PROMPT = `effective system prompt ${'lorem ipsum '.repeat(60)}`;

/**
 * Load the extension against a recording host.
 *
 * @param {Record<string, unknown>} rawConfig configuration to parse and inject.
 * @param {{ env?: Record<string, string | undefined>, strictPriority?: object, statusFetch?: Function }} [options]
 * @returns {{ handlers: Map<string, Function>, commands: Map<string, Function>, tools: string[] }}
 */
function loadExtension(rawConfig, options = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = [];
  let clock = 1_700_000_000_000;
  const config = rawConfig.agentHint
    ?? (rawConfig.version === undefined ? rawConfig : { enabled: false });
  createAgentHintExtension({
    config: parseConfig(config),
    env: options.env ?? {},
    now: () => (clock += 1000),
    strictPriority: options.strictPriority,
    statusFetch: options.statusFetch,
  })({
    registerCommand(name, config) { commands.set(name, config.handler); },
    registerTool(tool) { tools.push(tool.name); },
    on(event, handler) { handlers.set(event, handler); },
  });
  return { handlers, commands, tools };
}

/**
 * @returns {{ mode: string, hasUI: boolean, cwd: string, ui: object, sessionManager: object }} minimal context.
 */
function context(systemPrompt = LONG_SYSTEM_PROMPT) {
  return {
    mode: 'rpc',
    hasUI: false,
    cwd: process.cwd(),
    ui: { notify() {}, setStatus() {} },
    getSystemPrompt: () => systemPrompt,
    sessionManager: {
      getSessionId: () => SESSION_ID,
      // Deliberately disagree with the provider context: cache ranges must not use the append-only
      // session entry list, which can include compacted or off-branch history.
      getEntries: () => Array.from({ length: 5 }, () => ({ type: 'message' })),
    },
  };
}

/**
 * Create a genuine Pi session header so fork lineage is recovered through the same public API
 * used in production.
 *
 * @param {import('node:test').TestContext} t
 * @returns {{ id: string, file: string }}
 */
function parentSession(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-hint-parent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const id = 'parent-session';
  const file = join(dir, 'parent.jsonl');
  writeFileSync(file, `${JSON.stringify({
    type: 'session',
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  })}\n`, 'utf8');
  return { id, file };
}

/** A payload shaped like the one Pi hands to `before_provider_request`, with a foreign field present. */
function payload() {
  return {
    model: 'm',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 't' }],
    prompt_cache_key: 'another-extension-wrote-this',
  };
}

/**
 * Run one simulated provider request through the extension.
 *
 * The hook order is the host's, not a convenience: `context` runs before the provider adapter,
 * `before_provider_headers` runs before `before_provider_request`, and the payload hook may run
 * again on a retry. The real-HTTP test in hint.wire.test.js pinned that order down.
 *
 * @param {{ handlers: Map<string, Function> }} host host surface.
 * @param {Record<string, unknown>} [body] payload to send.
 * @returns {{ body: Record<string, unknown>, headers: Record<string, unknown>, decoded?: Record<string, unknown> }}
 */
function providerRound(host, body = payload()) {
  const ctx = context();
  const before = body;
  /** @type {Record<string, unknown>} */
  const headers = { 'content-type': 'application/json' };
  if (host.handlers.has('context_with_system')) {
    const messages = [
      { role: 'system', content: ctx.getSystemPrompt() },
      ...(Array.isArray(body.messages) ? body.messages : []),
    ];
    const replaced = host.handlers.get('context_with_system')({ type: 'context_with_system', messages }, ctx);
    assert.equal(replaced, undefined, 'the hint must only observe the final Pi context');
  }
  if (host.handlers.has('before_provider_headers')) {
    host.handlers.get('before_provider_headers')({ type: 'before_provider_headers', headers }, ctx);
  }
  if (host.handlers.has('before_provider_request')) {
    const replaced = host.handlers.get('before_provider_request')({ type: 'before_provider_request', payload: before }, ctx);
    assert.equal(replaced, undefined, 'the hint must never rewrite the request body');
  }
  const value = headers['X-Agent-Hint'];
  return {
    body: before,
    headers,
    ...(typeof value === 'string' ? { decoded: decodeAgentHint(value) } : {}),
  };
}

test('with the capability off, a request carries no hint header at all', () => {
  const host = loadExtension({ version: 1 });
  const round = providerRound(host);
  assert.equal('X-Agent-Hint' in round.headers, false, 'a disabled capability must add nothing');
  assert.equal(host.handlers.has('before_provider_request'), false, 'not even the hook is installed');
});

test('with the capability on, the header decodes to a valid hint', () => {
  const host = loadExtension({ version: 1, agentHint: { enabled: true } });
  host.handlers.get('session_start')({ reason: 'new' }, context());
  host.handlers.get('before_agent_start')({ systemPrompt: 'sys' }, context());
  host.handlers.get('turn_start')({ turnIndex: 1, timestamp: 1 });
  const round = providerRound(host);

  assert.deepEqual(validateAgentHint(round.decoded), []);
  assert.equal(round.decoded.session.session_id, SESSION_ID);
  assert.equal(round.decoded.session.call_index, 1);
  assert.equal(round.decoded.session.epoch, 0);
  assert.equal(round.decoded.session.agent_type, 'pi-agent');
  assert.equal(round.decoded.agent_status.state, 'running');
  assert.equal(typeof round.decoded.agent_status.state_since_ms, 'number');
  assert.deepEqual(round.decoded.priority, { level: 3, reason: 'user_waiting' });
  assert.deepEqual(round.decoded.cache_control, [
    { type: 'ephemeral', ttl_s: 600, range: { end: 2, unit: 'message' } },
  ]);
  assert.equal(round.body.agent_hint, undefined, 'the payload-era field is gone');
  assert.equal(round.body.prompt_cache_key, 'another-extension-wrote-this', 'and no body field was disturbed');
});

test('provider hooks supply latency and interval without relying on Pi turn timestamps', () => {
  const host = loadExtension({
    version: 1,
    agentHint: { enabled: true, predictionMinSamples: 1 },
  });
  const ctx = context();
  host.handlers.get('session_start')({ reason: 'new' }, ctx);
  host.handlers.get('before_agent_start')({ systemPrompt: 'sys' }, ctx);
  host.handlers.get('turn_start')({ turnIndex: 0 }, ctx);
  providerRound(host);
  host.handlers.get('after_provider_response')({ type: 'after_provider_response' }, ctx);
  host.handlers.get('turn_end')({ message: { usage: { output: 17 } } }, ctx);
  host.handlers.get('turn_start')({ turnIndex: 1 }, ctx);
  providerRound(host);
  host.handlers.get('after_provider_response')({ type: 'after_provider_response' }, ctx);
  host.handlers.get('turn_end')({ message: { usage: { output: 23 } } }, ctx);
  host.handlers.get('agent_settled')({}, ctx);

  host.handlers.get('before_agent_start')({ systemPrompt: 'sys' }, ctx);
  host.handlers.get('turn_start')({ turnIndex: 0 }, ctx);
  const nextRun = providerRound(host).decoded;
  assert.equal(typeof nextRun.prediction.latency_ms, 'number');
  assert.equal(typeof nextRun.prediction.interval_ms, 'number');
  assert.equal(nextRun.prediction.output_tokens, 17);
});

test('an aborted Pi 1.1 run does not train remaining work estimates', () => {
  const host = loadExtension({
    version: 1,
    agentHint: { enabled: true, predictionMinSamples: 1 },
  });
  const ctx = context();
  host.handlers.get('session_start')({ reason: 'new' }, ctx);
  host.handlers.get('before_agent_start')({ systemPrompt: 'sys' }, ctx);
  providerRound(host);
  host.handlers.get('after_provider_response')({ type: 'after_provider_response' }, ctx);
  host.handlers.get('turn_end')({ message: { usage: { output: 17 } } }, ctx);
  host.handlers.get('agent_settled')({ type: 'agent_settled', aborted: true }, ctx);

  host.handlers.get('before_agent_start')({ systemPrompt: 'sys' }, ctx);
  const prediction = providerRound(host).decoded.prediction;
  assert.equal(prediction.remaining_calls, undefined);
  assert.equal(prediction.remaining_time_ms, undefined);
  assert.equal(typeof prediction.latency_ms, 'number');
});

test('call_index advances with each request while the session id stays put', () => {
  const host = loadExtension({ version: 1, agentHint: { enabled: true } });
  host.handlers.get('session_start')({ reason: 'new' }, context());
  const first = providerRound(host).decoded;
  const second = providerRound(host).decoded;
  assert.equal(first.session.call_index, 1);
  assert.equal(second.session.call_index, 2);
  assert.equal(first.session.session_id, second.session.session_id);
});

test('the tool loop folds the wire state to pause while a tool is awaited', () => {
  const host = loadExtension({ version: 1, agentHint: { enabled: true } });
  host.handlers.get('session_start')({ reason: 'new' }, context());
  host.handlers.get('tool_execution_start')({ toolName: 'read', toolCallId: 'call-1' }, context());
  const whileTool = providerRound(host);
  // 简化字段 RFC §3.3.2：等工具返回属于"等外部事件"，wire 状态折成 pause，
  // 且不带 tools[]（tools 只在事件通道出现）。
  assert.equal(whileTool.decoded.agent_status.state, 'pause');
  assert.equal(whileTool.decoded.agent_status.tools, undefined);

  host.handlers.get('tool_execution_end')({ toolName: 'read', toolCallId: 'call-1' });
  const afterTool = providerRound(host);
  assert.equal(afterTool.decoded.agent_status.state, 'running');
});

test('并行工具期间 wire 状态始终是 pause', () => {
  const host = loadExtension({ version: 1, agentHint: { enabled: true } });
  host.handlers.get('session_start')({ reason: 'new' }, context());
  host.handlers.get('tool_execution_start')({ toolName: 'codemode', toolCallId: 'parent' });
  host.handlers.get('tool_execution_start')({
    toolName: 'read', toolCallId: 'parent/1', parentToolCallId: 'parent',
  });
  assert.equal(providerRound(host).decoded.agent_status.state, 'pause');

  host.handlers.get('tool_execution_end')({
    toolName: 'read', toolCallId: 'parent/1', parentToolCallId: 'parent', durationMs: 1,
  });
  assert.equal(providerRound(host).decoded.agent_status.state, 'pause');
  host.handlers.get('tool_execution_end')({ toolName: 'codemode', toolCallId: 'parent', durationMs: 10 });
  assert.equal(providerRound(host).decoded.agent_status.state, 'running');
});

test('cache control is omitted until Pi supplies the final context_with_system transcript', () => {
  const host = loadExtension({ version: 1, agentHint: { enabled: true } });
  const ctx = context();
  host.handlers.get('session_start')({ reason: 'new' }, ctx);
  const headers = {};
  host.handlers.get('before_provider_headers')({ type: 'before_provider_headers', headers }, ctx);
  const decoded = decodeAgentHint(headers['X-Agent-Hint']);
  assert.equal(decoded.cache_control, undefined);
});

test('an aborted empty assistant does not publish a cache range beyond provider messages', () => {
  const host = loadExtension({ version: 1, agentHint: { enabled: true } });
  host.handlers.get('session_start')({ reason: 'new' }, context());
  const body = payload();
  body.messages = [
    { role: 'user', content: 'cancelled task' },
    { role: 'assistant', content: [], stopReason: 'aborted' },
    { role: 'user', content: 'next task' },
  ];
  const round = providerRound(host, body);
  assert.equal(round.decoded.cache_control, undefined);
  assert.equal(round.decoded.session.call_index, 1);
  assert.equal(round.decoded.agent_status.state, 'running');
  assert.equal(round.body, body, 'the provider payload is not modified to make the counts agree');
  assert.deepEqual(validateAgentHint(round.decoded), []);

  const next = providerRound(host, body);
  assert.equal(next.decoded.cache_control, undefined, 'the empty assistant remains in this session');
});

test('every attempt of the same request rebuilds the hint instead of reusing a stale one', () => {
  // The host may re-enter the payload hook for a retry, and a hint describes the request being
  // sent. Reusing a previously built value would let a hint describe a request that is no longer
  // the one going out, which is worse than sending none.
  const host = loadExtension({ version: 1, agentHint: { enabled: true } });
  host.handlers.get('session_start')({ reason: 'new' }, context());
  const first = providerRound(host).decoded;
  host.handlers.get('tool_execution_start')({ toolName: 'read', toolCallId: 'c1' }, context());
  host.handlers.get('tool_execution_end')({ toolName: 'read', toolCallId: 'c1' }, context());
  const second = providerRound(host).decoded;

  assert.equal(first.session.call_index, 1);
  assert.equal(second.session.call_index, 2, 'the second request is numbered as such');
  assert.equal(second.agent_status.state, 'running', 'and describes the state it is actually sent in');
});

test('an existing hint header is left alone', () => {
  const host = loadExtension({ version: 1, agentHint: { enabled: true } });
  host.handlers.get('session_start')({ reason: 'new' }, context());
  host.handlers.get('before_provider_request')({ payload: payload() }, context());
  /** @type {Record<string, unknown>} */
  const headers = { 'x-agent-hint': 'from-somebody-else' };
  host.handlers.get('before_provider_headers')({ type: 'before_provider_headers', headers }, context());
  assert.equal(headers['x-agent-hint'], 'from-somebody-else');
  assert.equal(headers['X-Agent-Hint'], undefined, 'two producers writing one header would produce a value neither could decode');
});

test('a completed human wait is not restated as a future wait on the resumed request', () => {
  const host = loadExtension({ version: 1, agentHint: { enabled: true } });
  host.handlers.get('session_start')({ reason: 'new' }, context());
  // A user prompt opens the run; the approval gate is reached from inside it, which is how
  // `ctx.ui.confirm` is actually reached (a tool asks, the run blocks, the run resumes).
  host.handlers.get('before_agent_start')({ systemPrompt: 'sys' }, context());
  host.handlers.get('ui_prompt_start')({ kind: 'confirm' }, context());
  host.handlers.get('ui_prompt_end')({ kind: 'confirm' }, context());

  const resumed = providerRound(host).decoded;
  assert.deepEqual(resumed.priority, { level: 3, reason: 'user_waiting' });
  assert.equal(resumed.prediction?.expected_resume_s, undefined);

  // The agent then does something new, so the resume stops being the salient fact and the engine
  // is not asked to warm the prefix on every remaining turn of the run.
  host.handlers.get('tool_execution_start')({ toolName: 'read', toolCallId: 'c1' }, context());
  host.handlers.get('tool_execution_end')({ toolName: 'read', toolCallId: 'c1' }, context());
  const later = providerRound(host).decoded;
  assert.equal(later.session.call_index, 2, 'the second request of the conversation');
  // A continuation belongs to a run that is already open, so it is critical work but it is not
  // the request a person is waiting on.
  assert.deepEqual(later.priority, { level: 1, reason: 'critical_path' });
  assert.equal(later.prediction?.expected_resume_s, undefined);
});

test('a successful compaction advances the context epoch and the summary request carries no hint', () => {
  const host = loadExtension({ version: 1, agentHint: { enabled: true } });
  host.handlers.get('session_start')({ reason: 'new' }, context());
  assert.equal(providerRound(host).decoded.session.epoch, 0);

  // The armed window (session_before_compact → session_compact) is exactly the summarization
  // request: per RFC §1.3 it is an auxiliary request and must go out bare -- not even the
  // session identity rides along, and it consumes no call_index slot, so the epoch boundary
  // and the request sequence are both unaffected.
  host.handlers.get('session_before_compact')({}, context());
  const during = providerRound(host);
  assert.equal(during.decoded, undefined, 'a summarization request is auxiliary and carries no hint');
  assert.equal(during.headers['X-Agent-Hint'], undefined);

  host.handlers.get('session_compact')({}, context());
  const after = providerRound(host).decoded;
  assert.equal(after.session.epoch, 1, 'the conversation the engine was caching no longer exists');
  assert.equal(after.session.call_index, 2, 'the bare summary request is invisible to the sequence');
});

test('the trusted control plane is the only source of strict priority', () => {
  const withoutControlPlane = loadExtension({ version: 1, agentHint: { enabled: true } });
  withoutControlPlane.handlers.get('session_start')({ reason: 'new' }, context());
  assert.equal(providerRound(withoutControlPlane).decoded.strict_priority, undefined);

  const withBinding = loadExtension(
    { version: 1, agentHint: { enabled: true } },
    { env: { PI_AGENTHINT_STRICT_PRIORITY: '3:critical_path' } },
  );
  withBinding.handlers.get('session_start')({ reason: 'new' }, context());
  assert.deepEqual(providerRound(withBinding).decoded.strict_priority, { level: 3, reason: 'critical_path' });
});

test('a broken control-plane binding leaves the field out rather than guessing', () => {
  const host = loadExtension(
    { version: 1, agentHint: { enabled: true } },
    { env: { PI_AGENTHINT_STRICT_PRIORITY: 'urgent' } },
  );
  host.handlers.get('session_start')({ reason: 'new' }, context());
  assert.equal(providerRound(host).decoded.strict_priority, undefined);
  const status = host.commands.get('agenthint');
  assert.equal(typeof status, 'function');
});

test('state events are reported out of band, and the pause is one of them', async () => {
  const events = [];
  const host = loadExtension(
    {
      version: 1,
      agentHint: { enabled: true, reporting: { enabled: true, endpoint: 'http://collector.test/hint' } },
    },
    {
      statusFetch: async (url, init) => {
        events.push(JSON.parse(init.body));
        return { ok: true, status: 200 };
      },
    },
  );
  host.handlers.get('session_start')({ reason: 'new' }, context());
  host.handlers.get('ui_prompt_start')({ kind: 'confirm' }, context());
  host.handlers.get('ui_prompt_end')({ kind: 'confirm' }, context());
  host.handlers.get('agent_settled')({}, context());
  host.handlers.get('session_shutdown')({}, context());
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  const states = events.map((event) => event.agent_status.state);
  assert.ok(states.includes('running'), `expected a running event, saw ${JSON.stringify(states)}`);
  assert.ok(states.includes('pause'), `expected a pause event, saw ${JSON.stringify(states)}`);
  // settle 之后、shutdown 之前没有任何新事件（事件数不再增长），finalize 只在 shutdown 出现。
  assert.equal(states.filter((state) => state === 'finalize').length, 1, 'finalize is once per session');
  assert.equal(states.at(-1), 'finalize', 'only session_shutdown reports finalize, and it is the last event');
  assert.equal(states.at(-2), 'running', 'a settled run does not report finalize');
  const pause = events.find((event) => event.agent_status.state === 'pause');
  assert.equal(pause.agent_status.reason, 'human_approval');
  assert.equal(pause.session.session_id, SESSION_ID);
  assert.equal(typeof pause.prediction.expected_resume_s, 'number');
  assert.ok(pause.prediction.expected_resume_s > 0 && pause.prediction.expected_resume_s <= 300);
  assert.deepEqual(pause.prediction.next_action, { state: 'running' });
});

test('out-of-band tool events carry the complete parallel Pi tool set', async () => {
  const events = [];
  const host = loadExtension(
    { version: 1, agentHint: { enabled: true, reporting: { enabled: true, endpoint: 'http://collector.test/hint' } } },
    { statusFetch: async (_url, init) => { events.push(JSON.parse(init.body)); return { ok: true, status: 200 }; } },
  );
  host.handlers.get('session_start')({ reason: 'new' }, context());
  host.handlers.get('tool_execution_start')({
    toolName: 'task', toolCallId: 'a', args: { child_session_id: 'child-1', agent_type: 'researcher' },
  });
  host.handlers.get('tool_execution_start')({ toolName: 'read', toolCallId: 'b', args: {} });
  host.handlers.get('tool_execution_end')({ toolName: 'read', toolCallId: 'b' });
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  // 事件通道词表只有 running/pause/finalize：等工具的事件态是 pause，
  // tools[] 在这条 pause 事件上带出"正在等谁"。
  const toolEvents = events.filter((event) => event.agent_status.state === 'pause'
    && Array.isArray(event.agent_status.tools));
  assert.ok(toolEvents.some((event) => event.agent_status.tools.length === 2));
  const task = toolEvents.flatMap((event) => event.agent_status.tools).find((tool) => tool.call_id === 'a');
  assert.deepEqual(task, { name: 'task', call_id: 'a' });
  assert.deepEqual(toolEvents.at(-1).agent_status.tools, [task], 'ending one parallel tool leaves the other visible');
});

test('suspend refreshes the wait prediction on the out-of-band channel', async () => {
  const events = [];
  const host = loadExtension(
    {
      version: 1,
      agentHint: {
        enabled: true,
        suspendAfterMs: 1,
        reporting: { enabled: true, endpoint: 'http://collector.test/hint' },
      },
    },
    { statusFetch: async (_url, init) => { events.push(JSON.parse(init.body)); return { ok: true, status: 200 }; } },
  );
  host.handlers.get('session_start')({ reason: 'new' }, context());
  host.handlers.get('ui_prompt_start')({ kind: 'confirm' }, context());
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  // 事件通道没有 suspend 这个取值：等待超阈值与等审批一样，都是 pause。
  // 两次上报靠 prediction.expected_resume_s 变化区分（去重签名含它）。
  const pauses = events.filter((event) => event.agent_status.state === 'pause');
  assert.ok(pauses.length >= 2);
  const [first, last] = [pauses[0], pauses.at(-1)];
  assert.ok(last.prediction.expected_resume_s <= first.prediction.expected_resume_s);
  assert.deepEqual(last.prediction.next_action, { state: 'running' });
});

test('a fork survives extension reload and uses Pi resolved context as its message boundary', (t) => {
  const parent = parentSession(t);
  // This is deliberately a new extension instance: Pi tears down the old instance during fork.
  const host = loadExtension({ version: 1, agentHint: { enabled: true } });
  const childContext = context();
  childContext.sessionManager.getSessionId = () => 'child';
  childContext.sessionManager.getEntries = () => [
    { id: 'root', type: 'message' },
    { id: 'sibling-1', type: 'message' },
    { id: 'sibling-2', type: 'message' },
    { id: 'compaction', type: 'compaction' },
    { id: 'kept', type: 'message' },
  ];
  childContext.sessionManager.buildSessionContext = () => ({
    // Pi's projection has excluded the sibling branch and replaced compacted history with one
    // summary message. The extension must use this array, not count raw append-only entries.
    messages: [
      { role: 'user', content: 'compaction summary' },
      { role: 'assistant', content: 'kept response' },
    ],
  });
  assert.equal(host.handlers.has('session_before_fork'), false);
  host.handlers.get('session_start')({ reason: 'fork', previousSessionFile: parent.file }, childContext);
  const hint = providerRound(host).decoded;
  assert.equal(hint.session.parent_session_id, parent.id);
  assert.deepEqual(hint.session.derivation, { relation: 'fork', fork_point: 2 });
});

test('a fork status report does not claim a parent-child join', async (t) => {
  const parent = parentSession(t);
  const events = [];
  const host = loadExtension(
    { version: 1, agentHint: { enabled: true, reporting: { enabled: true, endpoint: 'http://collector.test/hint' } } },
    { statusFetch: async (_url, init) => { events.push(JSON.parse(init.body)); return { ok: true, status: 200 }; } },
  );
  const childContext = context();
  childContext.sessionManager.getSessionId = () => 'child';
  host.handlers.get('session_start')({ reason: 'fork', previousSessionFile: parent.file }, childContext);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.ok(events.length > 0);
  assert.equal(events[0].session.parent_session_id, parent.id);
  assert.deepEqual(events[0].session.derivation, { relation: 'fork' });
});

test('an unreadable previous fork session omits lineage without blocking requests', () => {
  const host = loadExtension({ version: 1, agentHint: { enabled: true } });
  const childContext = context();
  childContext.sessionManager.buildSessionContext = () => ({ messages: [{ role: 'user', content: 'x' }] });
  assert.doesNotThrow(() => {
    host.handlers.get('session_start')({ reason: 'fork', previousSessionFile: 'missing-session.jsonl' }, childContext);
  });
  const session = providerRound(host).decoded.session;
  assert.equal(session.parent_session_id, undefined);
  assert.equal(session.derivation, undefined);
});

test('a fork with no context projection keeps lineage and omits only fork_point', (t) => {
  const parent = parentSession(t);
  const host = loadExtension({ version: 1, agentHint: { enabled: true } });
  const childContext = context();
  childContext.sessionManager.getSessionId = () => 'child';
  host.handlers.get('session_start')({ reason: 'fork', previousSessionFile: parent.file }, childContext);
  const session = providerRound(host).decoded.session;
  assert.equal(session.parent_session_id, parent.id);
  assert.deepEqual(session.derivation, { relation: 'fork' });
});

test('legacy spawn, handoff and async-join environment inputs are ignored', () => {
  const host = loadExtension(
    { version: 1, agentHint: { enabled: true } },
    { env: {
      ASCEND_HINT_SESSION_ID: 'parent',
      PI_SUBAGENT_RUN_ID: 'run-1',
      ASCEND_HINT_DERIVATION_RELATION: 'handoff',
      ASCEND_HINT_DERIVATION_JOIN: 'async',
      ASCEND_HINT_AGENT_TYPE: 'researcher',
    } },
  );
  host.handlers.get('session_start')({ reason: 'new' }, context());
  const session = providerRound(host).decoded.session;
  assert.equal(session.parent_session_id, undefined);
  assert.equal(session.derivation, undefined);
  assert.equal(session.agent_type, 'pi-agent');
});

test('with reporting off, no state event leaves the process', async () => {
  const events = [];
  const host = loadExtension(
    { version: 1, agentHint: { enabled: true } },
    {
      statusFetch: async (url, init) => {
        events.push(JSON.parse(init.body));
        return { ok: true, status: 200 };
      },
    },
  );
  host.handlers.get('session_start')({ reason: 'new' }, context());
  host.handlers.get('ui_prompt_start')({ kind: 'confirm' }, context());
  host.handlers.get('agent_settled')({}, context());
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.deepEqual(events, [], 'the channel is off unless an endpoint is configured');
});

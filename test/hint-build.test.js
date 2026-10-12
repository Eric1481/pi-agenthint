/**
 * Tests for the pure hint builder and its `X-Agent-Hint` encoding.
 *
 * The builder is a pure function, which is what lets these tests assert byte-for-byte stability:
 * a "stable" field that changed value between two identical requests would destroy the prefix
 * cache the hint exists to protect.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = root;
const build = await import(pathToFileURL(join(pluginRoot, 'src', 'hint-build.js')).href);
const { parseConfig } = await import(pathToFileURL(join(pluginRoot, 'src', 'config.js')).href);
const { createHintState } = await import(pathToFileURL(join(pluginRoot, 'src', 'hint-state.js')).href);
const { validateAgentHint } = await import(pathToFileURL(join(pluginRoot, 'src', 'hint-schema.js')).href);

/** Configuration with hints on, since the builder is only reached in that state. */
const CONFIG = parseConfig({ enabled: true });

/**
 * Context size reported to the builder, excluding Pi's separately held system prompt.
 *
 * Pi's `context` event exposes the exact messages for the impending LLM call. The builder adds
 * one logical message for the effective system prompt, matching DSH's `[0, 1)` convention.
 */
const CONTEXT_MESSAGE_COUNT = 1;

/**
 * @param {Partial<Record<string, unknown>>} [overrides] snapshot fields to override.
 * @returns {Record<string, unknown>} a plausible snapshot.
 */
function snapshotOf(overrides = {}) {
  return { ...createHintState().snapshot(), ...overrides };
}

/**
 * @param {object} [options] build inputs to override.
 * @returns {{ hint?: Record<string, unknown>, skipped?: string }} the built hint.
 */
function buildHint(options = {}) {
  return build.buildAgentHint({
    // A user prompt has started a run and this is its first call: the ordinary case a hint is
    // built in, and the one whose priority the tests below pin down.
    snapshot: snapshotOf({ callIndex: 1, inRun: true, openingRequest: true }),
    identity: { sessionId: 's-1' },
    config: CONFIG,
    contextMessageCount: CONTEXT_MESSAGE_COUNT,
    systemPromptPresent: true,
    ...options,
  });
}

test('canonical serialization ignores key order, so two equal objects hash equal', () => {
  const left = { b: 1, a: { d: 2, c: 3 } };
  const right = { a: { c: 3, d: 2 }, b: 1 };
  assert.equal(build.stableStringify(left), build.stableStringify(right));
  assert.equal(build.digest(left), build.digest(right));
});

test('canonical serialization drops undefined members instead of emitting them', () => {
  assert.equal(build.stableStringify({ a: 1, b: undefined }), '{"a":1}');
});

test('the encoded header value is base64url JSON, round-tripping exactly', () => {
  const hint = buildHint().hint;
  const encoded = build.encodeAgentHint(hint);
  // base64url uses `-` and `_` and carries no padding: standard base64 would be a different
  // string, and gateways that forward the header as a query parameter would mangle it.
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(build.decodeAgentHint(encoded), hint);
});

test('a hint with no session id is not built, because nothing could address it', () => {
  const result = build.buildAgentHint({
    snapshot: snapshotOf(),
    identity: { sessionId: '' },
    config: CONFIG,
    contextMessageCount: CONTEXT_MESSAGE_COUNT,
    systemPromptPresent: true,
  });
  assert.equal(result.hint, undefined);
  assert.equal(result.skipped, 'no session id');
});

test('the header name is fixed by the protocol, not configurable', () => {
  assert.equal(build.HINT_HEADER, 'X-Agent-Hint');
});

test('an over-long session id is replaced by a stable digest of the same length class', () => {
  const long = 's'.repeat(200);
  const first = buildHint({ identity: { sessionId: long } }).hint.session.session_id;
  const second = buildHint({ identity: { sessionId: long } }).hint.session.session_id;
  assert.equal(first, second, 'the replacement is stable, so it still identifies one session');
  assert.ok(first.length <= build.MAX_SESSION_ID_LENGTH);
  assert.notEqual(first, long);
  assert.equal(buildHint({ identity: { sessionId: 'short' } }).hint.session.session_id, 'short');
});

test('a parent id without a Pi-confirmed fork is not published as a derivation', () => {
  const root = buildHint().hint;
  assert.equal(root.session.parent_session_id, undefined);
  assert.equal(root.session.derivation, undefined);

  const unconfirmed = buildHint({
    identity: { sessionId: 's-child', parentSessionId: 's-parent' },
  }).hint;
  assert.equal(unconfirmed.session.parent_session_id, undefined);
  assert.equal(unconfirmed.session.derivation, undefined);
});

test('a forked session publishes the fork relation it actually came from', () => {
  const state = createHintState();
  state.onSessionStart({ reason: 'fork', parentSessionId: 's-parent', at: 1 });
  state.beginRequest();
  const hint = build.buildAgentHint({
    snapshot: state.snapshot(),
    identity: { sessionId: 's-fork', parentSessionId: 's-parent' },
    config: CONFIG,
    contextMessageCount: CONTEXT_MESSAGE_COUNT,
    systemPromptPresent: true,
  }).hint;
  assert.equal(hint.session.derivation.relation, 'fork');
});

test('the published hint is always valid against its own protocol', () => {
  const hint = buildHint({
    snapshot: snapshotOf({ openingRequest: true, callIndex: 1 }),
    stats: { latencyMs: 1200, outputTokens: 300, intervalMs: 5000, nextTool: { name: 'read', expectedDurationS: 2, prob: 0.8 } },
  }).hint;
  assert.deepEqual(validateAgentHint(hint), []);
  assert.equal(hint.session.call_index, 1);
  assert.equal(hint.session.epoch, 0);
  assert.equal(hint.agent_status.state, 'running');
  assert.deepEqual(hint.priority, { level: 3, reason: 'user_waiting' });
});

test('priority ranks a person who is waiting above background work', () => {
  const resumed = snapshotOf({ resumedFrom: 'human_approval', status: { state: 'running', since: 1 } });
  assert.deepEqual(build.derivePriority(resumed, {}), { level: 4, reason: 'user_waiting' });

  // The first request of a run is the one a person is watching; later requests of the same run
  // are work the agent chose to do.
  const opening = snapshotOf({ openingRequest: true, callIndex: 1 });
  assert.deepEqual(build.derivePriority(opening, {}), { level: 3, reason: 'user_waiting' });

  const midRun = snapshotOf({ openingRequest: false, callIndex: 2 });
  assert.deepEqual(build.derivePriority(midRun, {}), { level: 2, reason: 'critical_path' });

  // A request sent before any user run was opened is not something a person is waiting on, so it
  // must not claim the interactive reason even though it is still critical work.
  const preRun = snapshotOf({ openingRequest: false, callIndex: 1 });
  assert.deepEqual(build.derivePriority(preRun, {}), { level: 2, reason: 'critical_path' });

  const compacting = snapshotOf({ compactionArmed: true });
  assert.deepEqual(build.derivePriority(compacting, {}), { level: 1, reason: 'background' });

});

test('a summarization request publishes no cache control, because it must not evict a prefix', () => {
  const hint = buildHint({ snapshot: snapshotOf({ compactionArmed: true, callIndex: 1 }) }).hint;
  assert.equal(hint.cache_control, undefined);
});

test('cache control ranges describe the conversation the request is about to send', () => {
  const hint = buildHint().hint;
  assert.deepEqual(hint.cache_control, [
    { type: 'pin', range: { end: 1, unit: 'message' } },
    { type: 'ephemeral', ttl_s: 600, range: { end: 2, unit: 'message' } },
  ]);
  // The logical sequence is [systemPrompt, ...context.messages], never the append-only session
  // history: compaction and branching rewrite the context that actually reaches the model.
  const longer = buildHint({ contextMessageCount: 5 }).hint;
  assert.equal(longer.cache_control[1].range.end, 6);
});

test('a zero TTL publishes the pin alone rather than an entry with no lifetime', () => {
  const config = { ...CONFIG, cacheTtlS: 0 };
  const hint = buildHint({ config }).hint;
  assert.deepEqual(hint.cache_control, [{ type: 'pin', range: { end: 1, unit: 'message' } }]);
});

test('an unknown context size publishes no cache control instead of a guessed range', () => {
  const hint = buildHint({ contextMessageCount: undefined }).hint;
  assert.equal(hint.cache_control, undefined, 'a range over an unknown model input is a guess');
});

test('prediction is omitted entirely when the observations do not support it', () => {
  const hint = buildHint({ stats: { samples: 0 } }).hint;
  assert.equal(hint.prediction, undefined, '"no estimate" and "zero" must stay distinguishable');
});

test('prediction is omitted when the session has not been observed at all', () => {
  const hint = buildHint().hint;
  assert.equal(hint.prediction, undefined, 'no window means nothing is known, not that nothing happens');
});

test('prediction carries each metric the observations support', () => {
  const hint = buildHint({
    stats: { latencyMs: 1200, outputTokens: 300, intervalMs: 5000, nextTool: { name: 'read', expectedDurationS: 2, prob: 0.8 } },
  }).hint;
  assert.deepEqual(hint.prediction, {
    latency_ms: 1200,
    output_tokens: 300,
    interval_ms: 5000,
    next_action: { state: 'tool', tools: [{ name: 'read', expected_duration_s: 2 }], prob: 0.8 },
  });
});

test('a resumed agent does not publish a stale pause prediction on the next request', () => {
  const snapshot = snapshotOf({
    status: { state: 'running', since: 5 },
    resumedFrom: 'human_approval',
    expectedWaitMs: 300000,
    observedWaitMs: 42000,
  });
  const hint = buildHint({ snapshot, stats: { settled: false } }).hint;
  assert.equal(hint.prediction, undefined, 'expected_resume_s belongs on the pause/suspend status event');
});

test('a wait that already outran its expectation publishes no remaining time', () => {
  const snapshot = snapshotOf({
    resumedFrom: 'human_input',
    expectedWaitMs: 60000,
    observedWaitMs: 90000,
  });
  const hint = buildHint({ snapshot, stats: { settled: true } }).hint;
  assert.equal(hint.prediction.expected_resume_s, undefined, '"0 seconds left" would read as "about to resume"');
});

test('a blocked agent with no expectation publishes only the next state', () => {
  const snapshot = snapshotOf({
    status: { state: 'pause', since: 5, reason: 'human_approval' },
    expectedWaitMs: undefined,
  });
  const hint = buildHint({ snapshot, stats: { settled: false } }).hint;
  assert.deepEqual(hint.prediction, { next_action: { state: 'running' } });
});

test('a settled agent predicts finalize and zero remaining calls', () => {
  const snapshot = snapshotOf({ status: { state: 'finalize', since: 9 } });
  const hint = buildHint({ snapshot, stats: { settled: true } }).hint;
  assert.deepEqual(hint.prediction.next_action, { state: 'finalize' });
  assert.equal(hint.prediction.remaining_calls, 0, 'only a known zero is published');
});

test('a running agent publishes no remaining_calls, because the number is unknown', () => {
  const hint = buildHint({ stats: { settled: false, latencyMs: 100 } }).hint;
  assert.equal(hint.prediction.remaining_calls, undefined);
});

test('learned priors publish positive remaining calls and time', () => {
  const hint = buildHint({ stats: { settled: false, remainingCalls: 3, remainingTimeMs: 12000 } }).hint;
  assert.equal(hint.prediction.remaining_calls, 3);
  assert.equal(hint.prediction.remaining_time_ms, 12000);
});

test('fork metadata includes the inherited message boundary without claiming join semantics', () => {
  const snapshot = snapshotOf({ relation: 'fork', forkPoint: 4 });
  const fork = buildHint({ snapshot, identity: { sessionId: 'child', parentSessionId: 'parent' } }).hint;
  assert.deepEqual(fork.session.derivation, { relation: 'fork', fork_point: 4 });
});

test('strict_priority is forwarded when the control plane supplied one', () => {
  const hint = buildHint({ strictPriority: { level: 3, reason: 'critical_path' } }).hint;
  assert.deepEqual(hint.strict_priority, { level: 3, reason: 'critical_path' });
});

test('strict_priority is absent when no trusted value exists', () => {
  // The document reserves the field for a trusted injector; a self-assigned hard priority would
  // let any agent preempt the queue it is competing for.
  assert.equal(buildHint().hint.strict_priority, undefined);
  assert.equal(buildHint({ strictPriority: undefined }).hint.strict_priority, undefined);
});

test('strict_priority is absent even when a value exists but the gate is closed', () => {
  const config = { ...CONFIG, strictPriority: false };
  const hint = buildHint({ config, strictPriority: { level: 3 } }).hint;
  assert.equal(hint.strict_priority, undefined);
});

test('the same inputs always produce the same bytes', () => {
  const inputs = {
    snapshot: snapshotOf({ callIndex: 2, lastToolName: 'read' }),
    identity: { sessionId: 's-1' },
    config: CONFIG,
    contextMessageCount: CONTEXT_MESSAGE_COUNT,
    systemPromptPresent: true,
    stats: { latencyMs: 900, outputTokens: 120 },
  };
  assert.equal(
    build.encodeAgentHint(build.buildAgentHint(inputs).hint),
    build.encodeAgentHint(build.buildAgentHint(inputs).hint),
  );
});

test('every gate can be switched off, and an all-off hint is nothing but the session', () => {
  const config = { ...CONFIG, priority: false, cacheControl: false, prediction: false };
  const hint = buildHint({ config, stats: { latencyMs: 500, nextTool: { name: 'read' } } }).hint;
  assert.deepEqual(Object.keys(hint).sort(), ['agent_status', 'session']);
});

test('an over-budget hint sheds its optional groups rather than being sent oversized', () => {
  const result = build.buildAgentHint({
    snapshot: snapshotOf({ callIndex: 1 }),
    identity: { sessionId: 's-1' },
    config: CONFIG,
    contextMessageCount: CONTEXT_MESSAGE_COUNT,
    systemPromptPresent: true,
    stats: { latencyMs: 1200, outputTokens: 300, intervalMs: 5000, nextTool: { name: 'read', expectedDurationS: 2, prob: 0.8 } },
    maxBytes: 200,
  });
  assert.notEqual(result.hint, undefined);
  assert.equal(result.hint.prediction, undefined);
  assert.deepEqual(validateAgentHint(result.hint), []);
});

test('a hint that cannot fit at all is skipped, not truncated', () => {
  const result = build.buildAgentHint({
    snapshot: snapshotOf(),
    identity: { sessionId: 's-1' },
    config: CONFIG,
    contextMessageCount: CONTEXT_MESSAGE_COUNT,
    systemPromptPresent: true,
    maxBytes: 1,
  });
  assert.equal(result.hint, undefined);
  assert.equal(result.skipped, 'over size budget');
});

test('agent_status publishes the tools being awaited, with their call ids', () => {
  const state = createHintState();
  state.onSessionStart({ at: 1 });
  state.onToolStart({ toolName: 'read', toolCallId: 'call-9', at: 2 });
  const hint = build.buildAgentHint({
    snapshot: state.snapshot(),
    identity: { sessionId: 's-1' },
    config: CONFIG,
    contextMessageCount: CONTEXT_MESSAGE_COUNT,
    systemPromptPresent: true,
  }).hint;
  assert.equal(hint.agent_status.state, 'tool');
  assert.equal(hint.agent_status.reason, 'await_tool');
  assert.deepEqual(hint.agent_status.tools, [{ name: 'read', call_id: 'call-9' }]);
});

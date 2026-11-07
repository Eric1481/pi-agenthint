/**
 * 字段发射实验：每个字段一个场景，走真实的 state machine + builder。
 *
 * 运行：node --test test/field-sending.test.js
 * 输出：每个字段的 expected / observed，失败即断言失败。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHintState } from '../src/hint-state.js';
import { buildAgentHint } from '../src/hint-build.js';

const CONFIG = Object.freeze({
  priority: true,
  cacheControl: true,
  prediction: true,
  strictPriority: false,
  cacheTtlS: null,
});

const STATS = (over = {}) => ({
  latencyMs: 4100,
  outputTokens: 420,
  intervalMs: 11800,
  remainingCalls: 3,
  remainingTimeMs: 30000,
  settled: false,
  ...over,
});

function hintOf(state, over = {}) {
  const built = buildAgentHint({
    snapshot: state.snapshot(),
    identity: { sessionId: over.sessionId ?? 's-7f3a2c' },
    config: CONFIG,
    stats: over.stats ?? STATS(),
    contextMessageCount: over.contextMessageCount ?? 9,
    systemPromptPresent: true,
    prefixTokens: over.prefixTokens ?? 4000,
  });
  return JSON.parse(JSON.stringify(built.hint));
}

function machine(over = {}) {
  const state = createHintState({ now: () => 1000, agentType: 'pi-agent', ...over });
  state.onSessionStart({ at: 1000, reason: 'new' });
  state.onRunStart(1100);
  return state;
}

test('session.session_id 恒定，跨请求不变', () => {
  const state = machine();
  state.beginRequest();
  const a = hintOf(state);
  state.beginRequest();
  const b = hintOf(state);
  assert.equal(a.session.session_id, 's-7f3a2c');
  assert.equal(b.session.session_id, a.session.session_id);
  console.log(`  session_id      : ${a.session.session_id} (call ${a.session.call_index} → ${b.session.call_index})`);
});

test('session.parent_session_id + derivation=fork 来自原生 fork 事件', () => {
  const state = createHintState({ now: () => 1000, agentType: 'pi-agent' });
  state.onSessionStart({ at: 1000, reason: 'fork', parentSessionId: 's-root01', forkPoint: 12 });
  state.onRunStart(1100);
  state.beginRequest();
  const h = hintOf(state);
  assert.equal(h.session.parent_session_id, 's-root01');
  assert.deepEqual(h.session.derivation, { relation: 'fork', fork_point: 12 });
  console.log(`  fork            : ${JSON.stringify(h.session.derivation)} parent=${h.session.parent_session_id}`);
});

test('session.parent_session_id + derivation=spawn 来自部署方声明', () => {
  const state = createHintState({ now: () => 1000, agentType: 'pi-agent' });
  state.onSessionStart({
    at: 1000,
    lineage: { relation: 'spawn', parent_session_id: 's-root01', join: 'sync' },
  });
  state.onRunStart(1100);
  state.beginRequest();
  const h = hintOf(state);
  assert.equal(h.session.parent_session_id, 's-root01');
  assert.deepEqual(h.session.derivation, { relation: 'spawn', join: 'sync' });
  console.log(`  spawn           : ${JSON.stringify(h.session.derivation)} parent=${h.session.parent_session_id}`);
});

test('session.epoch 在上下文压缩后 +1，分支导航再 +1', () => {
  const state = machine();
  state.beginRequest();
  const before = hintOf(state).session.epoch;

  state.onBeforeCompact();
  state.onCompactDone(2000);
  state.beginRequest();
  const afterCompact = hintOf(state).session.epoch;

  state.onTree(3000);
  state.beginRequest();
  const afterTree = hintOf(state).session.epoch;

  assert.equal(before, 0);
  assert.equal(afterCompact, 1);
  assert.equal(afterTree, 2);
  console.log(`  epoch           : ${before} → 压缩后 ${afterCompact} → 分支后 ${afterTree}`);
});

test('agent_status.state 覆盖五态（suspend 已换成 resume；settle 不等于 finalize）', () => {
  const state = machine();
  state.beginRequest();
  const running = hintOf(state).agent_status;

  state.onToolStart({ toolName: 'read', toolCallId: 'c1', at: 1200 });
  state.beginRequest();
  const tool = hintOf(state).agent_status;

  state.onToolEnd({ toolName: 'read', toolCallId: 'c1', at: 1300 });
  state.onPauseStart({ kind: 'confirm', at: 2000 });
  state.beginRequest();
  const pause = hintOf(state).agent_status;

  state.onPauseEnd({ kind: 'confirm', at: 42000 });
  state.beginRequest();
  const resume = hintOf(state).agent_status;
  state.markResumeReported();
  state.beginRequest();
  const afterResume = hintOf(state).agent_status;

  // 会话级 finalize：run 结束后请求头仍是 running；只有 session_shutdown 才让状态变 finalize。
  state.onSettled(5000);
  state.beginRequest();
  const settled = hintOf(state).agent_status;

  state.onShutdown(6000);
  const finalize = state.snapshot().status;

  assert.deepEqual({ state: running.state, since: typeof running.state_since_ms }, { state: 'running', since: 'number' });
  // 等工具返回属于"等外部事件"：wire 状态折成 pause（RFC §3.3.2 折叠表）
  assert.equal(tool.state, 'pause');
  assert.equal(pause.state, 'pause');
  assert.equal(resume.state, 'resume');
  assert.equal(afterResume.state, 'running');
  assert.equal(settled.state, 'running', 'a settled run still reports running on headers');
  assert.equal(finalize.state, 'finalize', 'only session shutdown reports finalize');
  // 只带 state 与 state_since_ms
  for (const block of [running, tool, pause, resume, afterResume, settled]) {
    assert.deepEqual(Object.keys(block).sort(), ['state', 'state_since_ms']);
  }
  console.log(`  state 序列      : ${running.state} → ${tool.state} → ${pause.state} → ${resume.state} → ${afterResume.state} → settle=${settled.state} → shutdown=${finalize.state}`);
});

test('内部 suspend 在出口折成 pause（不再有 reason/tools）', () => {
  const state = machine();
  state.onPauseStart({ kind: 'confirm', at: 2000 });
  state.onSuspend(120000);
  state.beginRequest();
  const s = hintOf(state).agent_status;
  assert.equal(s.state, 'pause');
  assert.equal(s.reason, undefined);
  assert.equal(s.tools, undefined);
  console.log(`  suspend 折并    : ${JSON.stringify(s)}`);
});

test('prediction 四个字段随观测样本发出', () => {
  const state = machine();
  state.beginRequest();
  const p = hintOf(state).prediction;
  assert.equal(p.remaining_calls, 3);
  assert.equal(p.output_tokens, 420);
  assert.equal(p.interval_ms, 11800);
  assert.equal(p.latency_ms, 4100);
  console.log(`  prediction      : ${JSON.stringify({ remaining_calls: p.remaining_calls, output_tokens: p.output_tokens, interval_ms: p.interval_ms, latency_ms: p.latency_ms })}`);
});

test('priority 二值化：开局 3/user_waiting，续接 1/critical_path', () => {
  const state = machine();
  state.beginRequest();
  const opening = hintOf(state).priority;
  state.beginRequest();
  const later = hintOf(state).priority;
  assert.deepEqual(opening, { level: 3, reason: 'user_waiting' });
  assert.deepEqual(later, { level: 1, reason: 'critical_path' });
  console.log(`  priority        : 开局 ${JSON.stringify(opening)} / 续接 ${JSON.stringify(later)}`);
});

test('cache_control 单条，end=逻辑输入条数，ttl 按 gap 推导并钳制', () => {
  const state = machine();
  state.beginRequest();
  const cc = hintOf(state, { contextMessageCount: 9 }).cache_control;
  assert.equal(cc.length, 1);
  assert.equal(cc[0].type, 'ephemeral');
  assert.equal(cc[0].range.end, 10);
  assert.ok(cc[0].ttl_s >= 60 && cc[0].ttl_s <= 3600);
  console.log(`  cache_control   : ${JSON.stringify(cc[0])}`);
});

test('cache_control 在前缀不足一个块时不发', () => {
  const state = machine();
  state.beginRequest();
  const h = hintOf(state, { prefixTokens: 50 });
  assert.equal(h.cache_control, undefined);
  console.log('  cache_control   : 前缀 50 token → 不发（符合预期）');
});

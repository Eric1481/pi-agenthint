/**
 * State-machine tests for AgentHint v2.
 *
 * The state machine is the only part of the capability that can be *wrong* rather than merely
 * absent, so these tests describe the observable state it publishes, not the code that publishes
 * it: which `agent_status.state` a given Pi event sequence produces, and when `epoch` moves.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = root;
const { createHintState } = await import(pathToFileURL(join(pluginRoot, 'src', 'hint-state.js')).href);

/**
 * Build a state machine on a fake clock so every published timestamp is predictable.
 *
 * @param {{ agentType?: string }} [options]
 * @returns {{ state: ReturnType<typeof createHintState>, at: (ms: number) => number }}
 */
function machine(options = {}) {
  let clock = 1000;
  const state = createHintState({
    now: () => clock,
    agentType: options.agentType,
  });
  return { state, at: (ms) => (clock = ms) };
}

test('a fresh process publishes running, call 0 and epoch 0', () => {
  const { state } = machine();
  const snapshot = state.snapshot();
  assert.equal(snapshot.status.state, 'running');
  assert.equal(snapshot.callIndex, 0, 'no request has been sent yet');
  assert.equal(snapshot.epoch, 0);
  assert.equal(snapshot.agentType, 'pi-agent');
});

test('call_index advances once per provider request and survives a re-run', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  assert.equal(state.beginRequest(), 1);
  state.onTurnStart({ turnIndex: 1 });
  assert.equal(state.beginRequest(), 2);
  // A new user prompt is a new run, not a new session: the ordinal keeps counting, because the
  // engine's cache lifetime is the session, not the run.
  state.onRunStart(2000);
  assert.equal(state.beginRequest(), 3);
  assert.equal(state.snapshot().callIndex, 3);
});

test('a run learns its opening call from the first request, not from the run start', () => {
  // Pi opens the run before the request exists, so the ordinal is only knowable at the request
  // boundary. Getting this wrong made the second request of a run look like its first.
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  assert.equal(state.snapshot().inRun, false, 'no run is open');
  assert.equal(state.snapshot().openingRequest, false);

  state.beginRequest();
  assert.equal(state.snapshot().inRun, false, 'a request outside a run does not open one');

  state.onRunStart(2000);
  assert.equal(state.beginRequest(), 2);
  assert.equal(state.snapshot().runOpenedAt, 2, 'this is the run opening call');
  assert.equal(state.snapshot().openingRequest, true, 'and it is published as such');
  assert.equal(state.beginRequest(), 3);
  assert.equal(state.snapshot().runOpenedAt, 2, 'the continuation belongs to the same run');
  assert.equal(state.snapshot().openingRequest, false, 'but it is not the opening call');
});

test('a session start resets the ordinal and the context epoch', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  state.beginRequest();
  state.onCompactDone(1500);
  assert.equal(state.snapshot().epoch, 1);
  state.onSessionStart({ at: 2000 });
  assert.equal(state.snapshot().callIndex, 0, 'a new conversation starts at call 1');
  assert.equal(state.snapshot().epoch, 0, 'and at context generation 0');
});

test('the tool lifecycle publishes tool with the awaited call and returns to running', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  state.onToolStart({ toolName: 'read', toolCallId: 'call-1', at: 2000 });
  const during = state.snapshot().status;
  assert.equal(during.state, 'tool');
  assert.equal(during.reason, 'await_tool');
  assert.equal(during.since, 2000);
  assert.deepEqual(during.tools, [{ name: 'read', call_id: 'call-1', startedAt: 2000 }]);

  state.onToolEnd({ toolName: 'read', toolCallId: 'call-1', at: 2500 });
  assert.equal(state.snapshot().status.state, 'running');
  assert.equal(state.snapshot().status.since, 2500);
  assert.equal(state.snapshot().status.tools, undefined);
});

test('parallel tools keep the agent in tool until the last result arrives', () => {
  // Reporting `running` after the first of two results would tell the engine the agent is
  // producing tokens while it is still blocked -- the exact inversion the protocol warns about.
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  state.onToolStart({ toolName: 'read', toolCallId: 'a', at: 1000 });
  state.onToolStart({ toolName: 'grep', toolCallId: 'b', at: 1010 });
  assert.equal(state.snapshot().status.state, 'tool');
  assert.equal(state.snapshot().status.tools.length, 2);

  state.onToolEnd({ toolName: 'read', toolCallId: 'a', at: 1100 });
  assert.equal(state.snapshot().status.state, 'tool', 'one tool is still running');
  assert.deepEqual(state.snapshot().status.tools.map((tool) => tool.call_id), ['b']);

  state.onToolEnd({ toolName: 'grep', toolCallId: 'b', at: 1200 });
  assert.equal(state.snapshot().status.state, 'running');
});

test('task is reported as an ordinary Pi tool, not as an inferred child agent', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  state.onToolStart({ toolName: 'task', toolCallId: 'delegate-1', at: 2000 });
  const status = state.snapshot().status;
  assert.equal(status.reason, 'await_tool');
  assert.equal(status.tools[0].name, 'task');
  assert.equal(status.tools[0].call_id, 'delegate-1');
});

test('a human prompt becomes pause, and a long one upgrades to suspend', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  state.onPauseStart({ kind: 'confirm', at: 2000 });
  const paused = state.snapshot().status;
  assert.equal(paused.state, 'pause');
  assert.equal(paused.reason, 'human_approval', 'confirm is the approval gate');
  assert.equal(paused.since, 2000);

  assert.equal(state.onSuspend(95000), true, 'the threshold elapsed, so the state really changed');
  assert.equal(state.snapshot().status.state, 'suspend');
  assert.equal(state.snapshot().status.reason, 'checkpoint');
  assert.equal(state.onSuspend(96000), false, 'a second call is not a transition');
});

test('a suspend request outside a pause is refused', () => {
  // The timer that drives the upgrade may fire after the wait already ended. Upgrading then
  // would publish a suspend for an agent that is running.
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  assert.equal(state.onSuspend(2000), false);
  assert.equal(state.snapshot().status.state, 'running');
});

test('a finished human wait is reported once and then retired by the next action', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  state.onPauseStart({ kind: 'confirm', at: 2000 });
  state.onPauseEnd({ kind: 'confirm', at: 42000 });
  const resumed = state.snapshot();
  assert.equal(resumed.resumedFrom, 'human_approval');
  assert.equal(resumed.observedWaitMs, 40000);
  assert.equal(resumed.expectedWaitMs, 300000);
  // resume 是状态不是事件：被放行的这一次请求报 resume，之后回到 running。
  assert.equal(resumed.status.state, 'resume');

  state.markResumeReported();
  assert.equal(state.snapshot().status.state, 'running');

  // A tool call is a new action, so "we just resumed" stops being the salient fact and the
  // engine is not asked to warm the prefix again on every remaining turn of the run.
  state.onToolStart({ toolName: 'read', toolCallId: 'c', at: 43000 });
  assert.equal(state.snapshot().resumedFrom, undefined);
  assert.equal(state.snapshot().observedWaitMs, undefined);
});

test('a non-approval human prompt is published as human_input with its own expectation', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  state.onPauseStart({ kind: 'input', at: 2000 });
  assert.equal(state.snapshot().status.reason, 'human_input');
  state.onPauseEnd({ kind: 'input', at: 3000 });
  assert.equal(state.snapshot().resumedFrom, 'human_input');
  assert.equal(state.snapshot().expectedWaitMs, 60000);
});

test('only a successful compaction advances the context epoch', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  state.onBeforeCompact();
  assert.equal(state.snapshot().compactionArmed, true);
  assert.equal(state.snapshot().epoch, 0, 'the window being open is not a rewrite');

  state.onCompactFailed();
  assert.equal(state.snapshot().epoch, 0, 'a failed compaction changed nothing');

  state.onBeforeCompact();
  state.onCompactDone(5000);
  assert.equal(state.snapshot().epoch, 1);
  assert.equal(state.snapshot().compactionArmed, false);
});

test('navigating the tree rewrites the conversation, so it also advances the epoch', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  state.onTree(4000);
  assert.equal(state.snapshot().epoch, 1);
});

test('a branch summary is armed only when a summary was actually requested', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  state.onBeforeTree({ preparation: { userWantsSummary: false } });
  assert.equal(state.snapshot().branchArmed, false, 'plain navigation is not a summarization request');
  state.onBeforeTree({ preparation: { userWantsSummary: true } });
  assert.equal(state.snapshot().branchArmed, true);
  state.onTree(4000);
  assert.equal(state.snapshot().branchArmed, false);
});

test('agent_settled ends the run without finalizing the session', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  state.onTurnStart({ turnIndex: 1, timestamp: 1100 });
  assert.equal(state.snapshot().status.state, 'running', 'a finished turn is not a finished run');
  state.onSettled(9000);
  // 会话级 finalize：run 结束只是回到空闲 running，会话还开着，不得报 finalize。
  assert.equal(state.snapshot().status.state, 'running', 'a settled run leaves the session in running');
  assert.equal(state.snapshot().inRun, false);
  state.onShutdown(12000);
  assert.equal(state.snapshot().status.state, 'finalize', 'only session shutdown finalizes');
  assert.equal(state.snapshot().status.since, 12000);
});

test('onSettled does not clobber an unreported resume', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  state.onPauseStart({ kind: 'confirm', at: 2000 });
  state.onPauseEnd({ kind: 'confirm', at: 9000 });
  state.onSettled(9500);
  // resume 是一次性边：还没被任何请求上报前，settle 不得把它冲掉。
  assert.equal(state.snapshot().status.state, 'resume');
});

test('only a Pi-confirmed fork creates a derivation', () => {
  const forked = machine();
  forked.state.onSessionStart({ reason: 'fork', parentSessionId: 's-parent', at: 1000 });
  assert.equal(forked.state.snapshot().relation, 'fork');
  assert.equal(forked.state.snapshot().parentSessionId, 's-parent');

  const unconfirmed = machine();
  unconfirmed.state.onSessionStart({ parentSessionId: 's-parent', at: 1000 });
  assert.equal(unconfirmed.state.snapshot().relation, undefined);
  assert.equal(unconfirmed.state.snapshot().parentSessionId, undefined);

  const root = machine();
  root.state.onSessionStart({ reason: 'new', at: 1000 });
  assert.equal(root.state.snapshot().relation, undefined, 'a root session has no derivation');
});

test('the agent type comes from standalone plugin configuration', () => {
  const configured = machine({ agentType: 'researcher' });
  assert.equal(configured.state.snapshot().agentType, 'researcher');
  assert.equal(machine().state.snapshot().agentType, 'pi-agent');
});

test('the same event sequence always yields the same snapshot', () => {
  // The builder is asserted byte-for-byte elsewhere; this is the state half of that property.
  const run = () => {
    const { state } = machine();
    state.onSessionStart({ at: 1000 });
    state.onRunStart(1000);
    state.onTurnStart({ turnIndex: 1, timestamp: 1000 });
    state.beginRequest();
    state.onToolStart({ toolName: 'read', toolCallId: 'x', at: 1200 });
    state.onToolEnd({ toolName: 'read', toolCallId: 'x', at: 1500 });
    return JSON.stringify(state.snapshot());
  };
  assert.equal(run(), run());
});


test('上下文条数回落时 epoch +1（没有 compact 事件也能识别重写）', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });

  state.noteLogicalCount(10);
  assert.equal(state.snapshot().epoch, 0, '首次只建立基线');

  state.noteLogicalCount(12);
  assert.equal(state.snapshot().epoch, 0, '增长不是重写');

  assert.equal(state.noteLogicalCount(4), true);
  assert.equal(state.snapshot().epoch, 1, '回落 → +1');

  state.noteLogicalCount(6);
  assert.equal(state.snapshot().epoch, 1, '回落之后恢复正常增长不再加');
});

test('compact 事件与条数回落不重复计数', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  state.noteLogicalCount(20);

  state.onBeforeCompact();
  state.onCompactDone(2000);          // 事件已记账
  state.noteLogicalCount(4);          // 同一条请求上再回落一次
  assert.equal(state.snapshot().epoch, 1, '只 +1');

  state.noteLogicalCount(6);
  state.noteLogicalCount(2);          // 下一轮再回落
  assert.equal(state.snapshot().epoch, 2, '下一轮回落照常 +1');
});

test('新会话重置条数基线', () => {
  const { state } = machine();
  state.onSessionStart({ at: 1000 });
  state.noteLogicalCount(20);
  state.noteLogicalCount(5);
  assert.equal(state.snapshot().epoch, 1);

  state.onSessionStart({ at: 2000 });
  state.noteLogicalCount(3);          // 新会话第一次见到 3，不该和上个会话比
  assert.equal(state.snapshot().epoch, 0);
});
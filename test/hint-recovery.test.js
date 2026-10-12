import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = root;
const { createAgentHintExtension } = await import(pathToFileURL(join(pluginRoot, 'src', 'index.js')).href);
const { parseConfig } = await import(pathToFileURL(join(pluginRoot, 'src', 'config.js')).href);
const { decodeAgentHint } = await import(pathToFileURL(join(pluginRoot, 'src', 'hint-build.js')).href);
const { HINT_CHECKPOINT_TYPE } = await import(pathToFileURL(join(pluginRoot, 'src', 'hint-recovery.js')).href);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-hint-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(process.cwd(), dir);
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: Date.now() });
  return { manager, file: manager.getSessionFile() };
}

function host(manager, enabled = true, appendError = false) {
  const handlers = new Map();
  const pi = {
    registerCommand() {},
    registerTool() {},
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(type, data) {
      if (appendError) throw new Error('session storage unavailable');
      manager.appendCustomEntry(type, data);
    },
  };
  createAgentHintExtension({
    config: parseConfig({ enabled }),
    env: {},
  })(pi);
  const ctx = {
    mode: 'rpc', hasUI: false, cwd: process.cwd(), sessionManager: manager,
    ui: { notify() {}, setStatus() {} }, getSystemPrompt: () => 'system',
  };
  function request() {
    handlers.get('context_with_system')?.({ messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
    ] }, ctx);
    const headers = {};
    handlers.get('before_provider_headers')?.({ headers }, ctx);
    return typeof headers['X-Agent-Hint'] === 'string'
      ? decodeAgentHint(headers['X-Agent-Hint']) : undefined;
  }
  return { handlers, ctx, request };
}

test('same Pi session retains request ordinal and epoch after process-style reload', async (t) => {
  const { manager, file } = fixture(t);
  const first = host(manager);
  await first.handlers.get('session_start')({ reason: 'new' }, first.ctx);
  assert.equal(first.request().session.call_index, 1);
  first.handlers.get('session_compact')();
  const afterCompact = first.request().session;
  assert.deepEqual([afterCompact.call_index, afterCompact.epoch], [2, 1]);

  const reopened = SessionManager.open(file);
  const second = host(reopened);
  await second.handlers.get('session_start')({ reason: 'resume' }, second.ctx);
  const hint = second.request();
  assert.equal(hint.session.session_id, manager.getSessionId());
  assert.equal(hint.session.call_index, 3);
  assert.equal(hint.session.epoch, 1);
  assert.ok(reopened.getEntries().some((entry) => entry.type === 'custom'
    && entry.customType === HINT_CHECKPOINT_TYPE));

  second.handlers.get('session_tree')();
  const reopenedAgain = SessionManager.open(file);
  const third = host(reopenedAgain);
  await third.handlers.get('session_start')({ reason: 'startup' }, third.ctx);
  const afterTree = third.request().session;
  assert.equal(afterTree.call_index, 4);
  assert.equal(afterTree.epoch, 2);
});

test('fork lineage survives reopening the child but not a distinct new session', async (t) => {
  const parent = fixture(t);
  const child = fixture(t);
  const first = host(child.manager);
  await first.handlers.get('session_start')({ reason: 'fork', previousSessionFile: parent.file }, first.ctx);
  const initial = first.request().session;
  assert.equal(initial.parent_session_id, parent.manager.getSessionId());
  assert.equal(initial.derivation.relation, 'fork');
  assert.equal(initial.derivation.fork_point, 1);

  const resumedManager = SessionManager.open(child.file);
  const resumed = host(resumedManager);
  await resumed.handlers.get('session_start')({ reason: 'resume' }, resumed.ctx);
  const restored = resumed.request().session;
  assert.equal(restored.parent_session_id, initial.parent_session_id);
  assert.deepEqual(restored.derivation, initial.derivation);
  assert.equal(restored.call_index, 2);

  const unrelated = fixture(t);
  const fresh = host(unrelated.manager);
  await fresh.handlers.get('session_start')({ reason: 'new' }, fresh.ctx);
  assert.equal(fresh.request().session.parent_session_id, undefined);
});

test('invalid and foreign checkpoints cannot replace the last trusted session state', async (t) => {
  const { manager, file } = fixture(t);
  const first = host(manager);
  await first.handlers.get('session_start')({ reason: 'new' }, first.ctx);
  first.request();
  manager.appendCustomEntry(HINT_CHECKPOINT_TYPE, {
    version: 1, sessionId: 'other-session', callIndex: 100, epoch: 100,
  });
  manager.appendCustomEntry(HINT_CHECKPOINT_TYPE, {
    version: 1, sessionId: manager.getSessionId(), callIndex: -1, epoch: 100,
  });
  const reopened = SessionManager.open(file);
  const second = host(reopened);
  await second.handlers.get('session_start')({ reason: 'resume' }, second.ctx);
  const resumed = second.request().session;
  assert.deepEqual([resumed.call_index, resumed.epoch], [2, 0]);
});

test('disabled Agent Hint leaves the Pi session free of checkpoints', async (t) => {
  const { manager } = fixture(t);
  const disabled = host(manager, false);
  await disabled.handlers.get('session_start')({ reason: 'new' }, disabled.ctx);
  assert.equal(disabled.request(), undefined);
  assert.equal(manager.getEntries().some((entry) => entry.type === 'custom'
    && entry.customType === HINT_CHECKPOINT_TYPE), false);
});

test('checkpoint write failure does not block a provider hint or request', async (t) => {
  const { manager } = fixture(t);
  const failing = host(manager, true, true);
  await failing.handlers.get('session_start')({ reason: 'new' }, failing.ctx);
  assert.equal(failing.request().session.call_index, 1);
  assert.equal(manager.getEntries().some((entry) => entry.type === 'custom'
    && entry.customType === HINT_CHECKPOINT_TYPE), false);
});

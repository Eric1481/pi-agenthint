import { SessionManager, VERSION } from '@earendil-works/pi-coding-agent';
import { existsSync } from 'node:fs';

import { parseConfig, resolveConfig } from './config.js';
import { HINT_HEADER, buildAgentHint, encodeAgentHint, estimatePrefixTokens } from './hint-build.js';
import { createStatusReporter, resolveStrictPriority } from './hint-control.js';
import { readHintCheckpoint, writeHintCheckpoint } from './hint-recovery.js';
import { createHintState } from './hint-state.js';
import { createHintStats } from './hint-stats.js';

const VERIFIED_PI_VERSIONS = ['1.1.0'];

/**
 * 内部状态 → 状态事件词表（简化字段 RFC §3.3.2 / §3.5.2.3）。
 *
 * 事件通道与请求头**同一套四值** `running | pause | resume | finalize`（事件侧另
 * 可带细分值 `tool`）：
 * - `tool` / `suspend` 在消费侧都是"在等外部事件"（工具返回、人等审批）→ `pause`；
 * - `resume` 是「人刚放行」的一次性边，事件通道同样发一条（与请求头同一时刻）。
 *   2026-11-07 规格裁定：事件词表含 `resume`；此前把它折成 `running` 是错的。
 */
const EVENT_STATE = { tool: 'pause', suspend: 'pause' };

function eventState(state) {
  return EVENT_STATE[state] ?? state;
}

function extension(pi, options = {}) {
  for (const method of ['registerCommand', 'on']) {
    if (typeof pi?.[method] !== 'function') throw new Error(`pi-agenthint requires ExtensionAPI.${method}`);
  }

  const env = options.env ?? process.env;
  const loadResult = options.config === undefined
    ? resolveConfig({ env })
    : { config: parseConfig(options.config), source: 'injected' };
  const config = loadResult.config;
  const now = options.now ?? Date.now;
  const state = createHintState({
    now,
    agentType: config.agentType,
    humanApprovalWaitMs: config.humanApprovalWaitMs,
    humanInputWaitMs: config.humanInputWaitMs,
  });
  const stats = createHintStats({
    window: config.predictionWindow,
    policy: config.predictionPolicy,
    minSamples: config.predictionMinSamples,
  });
  const strict = resolveStrictPriority({
    raw: env[config.strictPriorityEnv],
    injected: options.strictPriority,
  });
  const reporter = createStatusReporter({
    enabled: config.reporting.enabled,
    endpoint: config.reporting.endpoint,
    token: () => env[config.reporting.tokenEnv],
    timeoutMs: config.reporting.timeoutMs,
    maxRetries: config.reporting.maxRetries,
    queueLimit: config.reporting.queueLimit,
    fetchImpl: options.statusFetch,
  });

  let currentSessionId;
  let currentContextMessageCount;
  let currentSystemPromptPresent;
  let currentPrefixTokens;
  let requestMessageCount = 0;
  let lastHint;
  let lastSkip;
  let lastReportedStatus;
  // 事件通道上「这条 resume 边已经发过」的进入时刻。resume 是一次性边：同一条边
  // 第二次上报要报成 running，否则消费方会以为又放行了一次。
  let reportedResumeSince;
  let suspendTimer;
  const counters = { injected: 0, skipped: 0 };

  function sessionIdOf(ctx) {
    try {
      const id = ctx?.sessionManager?.getSessionId?.();
      return typeof id === 'string' && id !== '' ? id : undefined;
    } catch {
      return undefined;
    }
  }

  function sessionKey(ctx) {
    const live = sessionIdOf(ctx);
    if (live !== undefined) currentSessionId = live;
    return live ?? currentSessionId ?? 'unknown-session';
  }

  function forkPointOf(ctx) {
    try {
      const messages = ctx?.sessionManager?.buildSessionContext?.()?.messages;
      return Array.isArray(messages) ? messages.length : undefined;
    } catch {
      return undefined;
    }
  }

  function parentSessionIdOf(previousSessionFile) {
    if (typeof previousSessionFile !== 'string' || previousSessionFile === ''
      || !existsSync(previousSessionFile)) return undefined;
    try {
      const id = SessionManager.open(previousSessionFile).getHeader()?.id;
      return typeof id === 'string' && id !== '' ? id : undefined;
    } catch {
      return undefined;
    }
  }

  function checkpoint() {
    if (!config.enabled) return;
    writeHintCheckpoint(pi, currentSessionId, state.snapshot());
  }

  function identity(sessionId) {
    const snapshot = state.snapshot();
    return snapshot.relation === 'fork' && snapshot.parentSessionId !== undefined
      && snapshot.parentSessionId !== sessionId
      ? { sessionId, parentSessionId: snapshot.parentSessionId }
      : { sessionId };
  }

  function reportStatus(context = {}) {
    if (!config.reporting.enabled) return;
    try {
      const snapshot = state.snapshot();
      const at = context.at ?? now();
      const waiting = snapshot.status.state === 'pause' || snapshot.status.state === 'suspend';
      const expectedResumeS = waiting && typeof snapshot.expectedWaitMs === 'number'
        ? Math.max(0, Math.ceil((snapshot.expectedWaitMs
          - Math.max(0, at - (snapshot.waitStartedAt ?? at))) / 1000))
        : undefined;
      // resume 是一次性边：同一条边（同一个 state_since_ms）只报一次，之后再上报
      // 报成 running——持续态是 running，边只标记「刚刚被放行」那一刻。
      const rawState = snapshot.status.state;
      const repeatEdge = rawState === 'resume'
        && typeof snapshot.status.since === 'number'
        && snapshot.status.since === reportedResumeSince;
      const wireState = repeatEdge ? 'running' : eventState(rawState);
      const signature = JSON.stringify({ status: snapshot.status, expectedResumeS, wireState });
      if (signature === lastReportedStatus) return;
      lastReportedStatus = signature;
      if (rawState === 'resume' && !repeatEdge && typeof snapshot.status.since === 'number') {
        reportedResumeSince = snapshot.status.since;
      }
      reporter.send({
        session: {
          session_id: sessionKey(),
          ...(snapshot.parentSessionId === undefined ? {} : { parent_session_id: snapshot.parentSessionId }),
          ...(snapshot.relation !== 'fork' ? {} : { derivation: {
            relation: 'fork',
            ...(snapshot.forkPoint === undefined ? {} : { fork_point: snapshot.forkPoint }),
          } }),
        },
        agent_status: {
          state: wireState,
          ...(typeof snapshot.status.since === 'number' ? { state_since_ms: snapshot.status.since } : {}),
          ...(snapshot.status.reason === undefined ? {} : { reason: snapshot.status.reason }),
          ...(Array.isArray(snapshot.status.tools) ? { tools: snapshot.status.tools.map((tool) => ({
            name: tool.name,
            ...(tool.call_id === undefined ? {} : { call_id: tool.call_id }),
          })) } : {}),
        },
        ...(!waiting ? {} : { prediction: {
          ...(expectedResumeS === undefined ? {} : { expected_resume_s: expectedResumeS }),
          next_action: { state: 'running' },
        } }),
      });
    } catch {
      // Reporting is advisory and must never break a Pi event.
    }
  }

  function clearSuspendTimer() {
    if (suspendTimer !== undefined) {
      clearTimeout(suspendTimer);
      suspendTimer = undefined;
    }
  }

  function armSuspendTimer() {
    clearSuspendTimer();
    if (!config.enabled || config.suspendAfterMs <= 0) return;
    suspendTimer = setTimeout(() => {
      suspendTimer = undefined;
      const at = now();
      if (state.onSuspend(at)) {
        stats.observeNextState(sessionKey(), 'suspend');
        reportStatus({ at });
      }
    }, config.suspendAfterMs);
    suspendTimer.unref?.();
  }

  function attach(event, ctx) {
    if (!config.enabled) return;
    try {
      const headers = event?.headers;
      if (headers === null || typeof headers !== 'object') return;
      const existing = Object.keys(headers).find((key) => key.toLowerCase() === HINT_HEADER.toLowerCase());
      if (existing !== undefined) {
        counters.skipped += 1;
        lastSkip = `a ${HINT_HEADER} header was already present`;
        return;
      }
      const sessionId = sessionKey(ctx);
      // RFC §1.3 / §3.3.5: the compaction summary window (armed by `session_before_compact`,
      // disarmed by `session_compact` / `session_compact_failed`) is an auxiliary request. It
      // carries no hint at all and is invisible to the hint sequence: it consumes neither a
      // call_index slot nor checkpoint state. buildAgentHint applies the same skip on its own,
      // so direct builders of the armed snapshot see the identical exemption.
      if (state.snapshot().compactionArmed === true) {
        counters.skipped += 1;
        lastSkip = 'auxiliary request (compaction window, RFC §1.3: no hint)';
        return;
      }
      const callIndex = state.beginRequest();
      checkpoint();
      const snapshot = { ...state.snapshot(), callIndex };
      const requestAt = now();
      stats.observeProviderStart(sessionId, requestAt);
      const built = buildAgentHint({
        snapshot,
        identity: identity(sessionId),
        config,
        contextMessageCount: currentContextMessageCount,
        systemPromptPresent: currentSystemPromptPresent === true,
        prefixTokens: currentPrefixTokens,
        stats: stats.snapshot(sessionId, snapshot.agentType, requestAt),
        strictPriority: strict.binding,
      });
      if (built.hint === undefined) {
        counters.skipped += 1;
        lastSkip = built.skipped ?? 'not built';
        return;
      }
      headers[HINT_HEADER] = encodeAgentHint(built.hint);
      lastHint = built.hint;
      lastSkip = undefined;
      counters.injected += 1;
    } catch (error) {
      counters.skipped += 1;
      lastSkip = error instanceof Error ? error.message : String(error);
    }
  }

  function status(ctx) {
    return {
      package: 'pi-agenthint',
      piVersion: VERSION,
      verifiedPiVersions: VERIFIED_PI_VERSIONS,
      hostVersionVerified: VERIFIED_PI_VERSIONS.includes(VERSION),
      configSource: loadResult.source,
      ...(loadResult.error === undefined ? {} : { configError: loadResult.error }),
      enabled: config.enabled,
      header: HINT_HEADER,
      ...counters,
      ...(lastSkip === undefined ? {} : { lastSkip }),
      strictPriority: config.strictPriority ? strict.reason : 'disabled by configuration',
      channel: reporter.state(),
      state: state.snapshot(),
      predictionInputs: stats.snapshot(sessionKey(ctx)),
      last: lastHint ?? null,
    };
  }

  pi.registerCommand('agenthint', {
    description: 'Show Agent Hint injection, lifecycle, prediction, and reporting status',
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(status(ctx)), 'info'),
  });

  pi.on('session_start', (event, ctx) => {
    const sessionId = sessionIdOf(ctx);
    const fork = event?.reason === 'fork' ? {
      parentSessionId: parentSessionIdOf(event?.previousSessionFile),
      forkPoint: forkPointOf(ctx),
    } : undefined;
    const recovered = event?.reason === 'fork' || event?.reason === 'new'
      ? undefined : readHintCheckpoint(ctx?.sessionManager, sessionId);
    state.onSessionStart({
      reason: event?.reason,
      parentSessionId: fork?.parentSessionId,
      forkPoint: fork?.forkPoint,
      // Pi has no native subagent event, so a spawn can only be reported when the process that
      // started this session declares it. `fork` from Pi's own lifecycle event still wins.
      lineage: config.lineage,
      recovered,
    });
    currentSessionId = sessionId;
    if (event?.reason === 'fork' && fork?.parentSessionId !== undefined) checkpoint();
    stats.forget(sessionId ?? 'unknown-session');
    lastReportedStatus = undefined;
    lastSkip = undefined;
    currentContextMessageCount = undefined;
    currentSystemPromptPresent = undefined;
    currentPrefixTokens = undefined;
    reportStatus();
    if (ctx?.mode === 'tui' && loadResult.error !== undefined) {
      ctx.ui.notify(`pi-agenthint configuration error; disabled: ${loadResult.error}`, 'error');
    }
    if (ctx?.mode === 'tui' && !VERIFIED_PI_VERSIONS.includes(VERSION)) {
      ctx.ui.notify(`pi-agenthint has not been verified with Pi ${VERSION}.`, 'warning');
    }
  });

  pi.on('before_agent_start', () => {
    const at = now();
    state.onRunStart(at);
    stats.observeRunStart(sessionKey(), state.snapshot().agentType, at);
  });
  pi.on('turn_start', (event) => state.onTurnStart(event));
  pi.on('turn_end', (event) => {
    const usage = event?.message?.usage;
    stats.observeOutputTokens(sessionKey(), usage?.output ?? usage?.completion_tokens);
  });
  pi.on('tool_execution_start', (event) => {
    if (typeof event?.parentToolCallId === 'string' && event.parentToolCallId !== '') return;
    const at = now();
    state.onToolStart({ ...event, at });
    stats.observeToolStart(sessionKey(), event?.toolName, at, event?.toolCallId);
    reportStatus({ at });
  });
  pi.on('tool_execution_end', (event) => {
    if (typeof event?.parentToolCallId === 'string' && event.parentToolCallId !== '') return;
    const at = now();
    state.onToolEnd({ ...event, at });
    stats.observeToolEnd(sessionKey(), event?.toolName, at, event?.toolCallId, event?.durationMs);
    reportStatus({ at });
  });
  pi.on('session_before_compact', () => state.onBeforeCompact());
  pi.on('session_compact', () => {
    state.onCompactDone();
    checkpoint();
    reportStatus();
  });
  pi.on('session_compact_failed', () => {
    state.onCompactFailed();
    reportStatus();
  });
  pi.on('session_before_tree', (event) => state.onBeforeTree(event));
  pi.on('session_tree', () => {
    state.onTree();
    checkpoint();
    reportStatus();
  });
  pi.on('ui_prompt_start', (event) => {
    const at = now();
    state.onPauseStart({ ...event, at });
    stats.observeNextState(sessionKey(), 'pause');
    armSuspendTimer();
    reportStatus({ at });
  });
  pi.on('ui_prompt_end', (event) => {
    clearSuspendTimer();
    state.onPauseEnd({ ...event, at: now() });
    reportStatus();
  });
  pi.on('agent_settled', (event) => {
    const at = now();
    state.onSettled(at);
    if (event?.aborted === true) stats.observeAborted(sessionKey());
    else stats.observeSettled(sessionKey(), at);
    reportStatus({ at });
  });
  pi.on('session_shutdown', () => {
    clearSuspendTimer();
    state.onShutdown();
    reportStatus();
  });

  if (config.enabled) {
    pi.on('context_with_system', (event) => {
      const messages = Array.isArray(event?.messages) ? event.messages : undefined;
      if (messages === undefined) {
        currentContextMessageCount = undefined;
        currentSystemPromptPresent = undefined;
        currentPrefixTokens = undefined;
        return;
      }
      currentSystemPromptPresent = messages[0]?.role === 'system';
      const hasEmptyAssistant = messages.some((message) => message?.role === 'assistant'
        && Array.isArray(message.content) && message.content.length === 0);
      currentContextMessageCount = hasEmptyAssistant
        ? undefined : messages.length - (currentSystemPromptPresent ? 1 : 0);
      // Only a prefix of at least one engine block can be cached at all; a shorter declaration
      // would ask the engine to retain something it never stores.
      currentPrefixTokens = hasEmptyAssistant ? undefined : estimatePrefixTokens(messages);
    });
    pi.on('before_provider_headers', (event, ctx) => attach(event, ctx));
    pi.on('before_provider_request', (event) => {
      const messages = Array.isArray(event?.payload?.messages) ? event.payload.messages : [];
      requestMessageCount = messages.length;
      // 上下文被重写但没有 compact 事件时（真机上的溢出裁剪正是如此），用条数回落兜底 +1。
      // 这里拿到的是本次 provider 载荷的真实条数，和 header 里 range.end 的口径一致。
      if (messages.length > 0) state.noteLogicalCount(messages.length);
    });
  }

  pi.on('after_provider_response', () => {
    try {
      stats.observeProviderEnd(sessionKey(), now(), requestMessageCount);
    } catch {
      // Observation must never disturb the host response.
    }
  });
}

export function createAgentHintExtension(options) {
  return (pi) => extension(pi, options);
}

export default createAgentHintExtension();

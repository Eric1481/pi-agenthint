/**
 * Hint state machine: derive AgentHint v2 state from Pi's own event flow.
 *
 * Implements the AgentHint v2 lifecycle vocabulary directly from Pi's public events and maps to
 * the v2 schema of 《Agent Hint 字段&实现定义》 §2: this now tracks what `session` and
 * `agent_status` need -- derivation, agent type, the per-request call ordinal, the context
 * epoch, the five-state lifecycle and the in-flight tool set -- instead of the request-class
 * and wait-kind vocabulary of the payload-era protocol.
 *
 * Design rules, unchanged from the skeleton because they are what makes the rest testable:
 *
 * - the state machine only *records*; it never touches a request or a header, so even a wrong
 *   state can only produce a wrong hint, never a broken request;
 * - every value is derived from an event Pi already emits or from an injected clock, never from
 *   a hidden random source, so the same event sequence always yields the same state;
 * - one-shot markers are armed by the event that opens them and disarmed by the event that
 *   closes them, never consumed by a build -- a build that mutated state could not be a pure
 *   function of its inputs.
 *
 * Event semantics that only a wire-level test could settle (tests/hint.wire.test.js):
 *
 *   `turn_start` fires **once per LLM call inside a run**, not once per user prompt, and it
 *   carries `turnIndex` and `timestamp`. The real per-run boundary is `before_agent_start`;
 *   clearing tool and wait markers on `turn_start` made the request carrying a tool result look
 *   like the first request of a conversation, which the wire test caught.
 *
 *   `ui_prompt_start` / `ui_prompt_end` are host-level events, and `confirm` is the approval
 *   gate. "A human is blocking the agent" therefore needs no instrumentation in business code.
 *
 *   `agent_settled` is the only event that means "this run is over and nothing automatic
 *   follows" -- DSH's `idle` is not the same claim, and neither is `turn_end`. A finished
 *   run is NOT a finished session: settle returns the session to idle `running`, and only
 *   `session_shutdown` (the whole session closing) is a `finalize`.
 */

import { DEFAULT_AGENT_TYPE } from './config.js';
import { STATUS_REASONS } from './hint-schema.js';

/** @typedef {'running' | 'tool' | 'pause' | 'resume' | 'suspend' | 'finalize'} AgentState */

/**
 * Session relations this extension can publish.
 *
 * `fork` comes from Pi's own session lifecycle event. Pi has no subagent mechanism, so `spawn`
 * can only be truthful when the deployment that created this session declares the lineage
 * (see `event.lineage` in onSessionStart).
 */
export const DECLARED_RELATIONS = ['fork', 'spawn'];

/**
 * @typedef {object} AgentStatus
 * @property {AgentState} state          lifecycle state to publish.
 * @property {number | undefined} since  Unix ms timestamp of entering that state.
 * @property {string | undefined} reason published reason; this plugin only ever states one of the
 *   values in `STATUS_REASONS` (hint-schema.js).
 * @property {Array<{ name: string, call_id?: string, startedAt?: number }>} [tools]
 *   tools being awaited, present only in the `tool` state.
 */

/**
 * @typedef {object} HintSnapshot
 * @property {AgentStatus} status          current lifecycle state.
 * @property {number} callIndex            ordinal of the next request in this session (from 1).
 * @property {number} epoch                context generation; bumped when a rewrite lands.
 * @property {number} turnIndex            Pi's own turn ordinal for the current run.
 * @property {boolean} inRun               a user-initiated run is open.
 * @property {boolean} compactionArmed     a summarization request window is open.
 * @property {boolean} branchArmed         a branch-summary request window is open.
 * @property {'human_approval' | 'human_input' | undefined} resumedFrom
 *   the kind of human wait whose completion has not yet been reported on a request.
 * @property {number | undefined} observedWaitMs measured duration of that wait.
 * @property {number | undefined} expectedWaitMs configured expectation for that wait kind.
 * @property {number | undefined} waitStartedAt start of an active pause/suspend.
 * @property {string | undefined} lastToolName     tool that most recently started.
 * @property {boolean} openingRequest              the request being built is the opening call of
 *   the run that is currently open.
 * @property {number | undefined} runOpenedAt      the ordinal of that opening call, when known.
 * @property {'fork'|undefined} relation
 * @property {number|undefined} forkPoint inherited message boundary for a fork.
 */

/**
 * Create a hint state machine.
 *
 * The returned object is deliberately small: subscribe it to Pi's events, call `beginRequest()`
 * once per provider request, then read `snapshot()` when building a hint. Nothing here performs
 * I/O, and time is only ever taken from an event or from the injected clock.
 *
 * @param {{
 *   now?: () => number,
 *   agentType?: string,
 *   humanApprovalWaitMs?: number,
 *   humanInputWaitMs?: number,
 * }} [options]
 *   `now` is the clock used for state transitions that Pi does not timestamp (tests inject a
 *   fake one); `agentType` is the configured agent type; the wait values are what the protocol
 *   publishes as the expectation, not timers.
 * @returns {{
 *   onSessionStart: (event?: { reason?: string, parentSessionId?: string, forkPoint?: number,
 *     recovered?: { callIndex: number, epoch: number, parentSessionId?: string, forkPoint?: number },
 *     at?: number }) => void,
 *   onRunStart: (at?: number) => void,
 *   onTurnStart: (event?: { turnIndex?: number, timestamp?: number }) => void,
 *   onToolStart: (event?: { toolName?: string, toolCallId?: string, at?: number }) => void,
 *   onToolEnd: (event?: { toolName?: string, toolCallId?: string, at?: number }) => void,
 *   onBeforeCompact: () => void,
 *   onCompactDone: (at?: number) => void,
 *   onCompactFailed: () => void,
 *   onBeforeTree: (event?: { preparation?: { userWantsSummary?: boolean } }) => void,
 *   onTree: (at?: number) => void,
 *   onPauseStart: (event?: { kind?: string, at?: number }) => void,
 *   onPauseEnd: (event?: { kind?: string, at?: number }) => void,
 *   onSuspend: (at?: number) => boolean,
 *   onSettled: (at?: number) => void,
 *   onShutdown: (at?: number) => void,
 *   beginRequest: () => number,
 *   markResumeReported: () => void,
 *   snapshot: () => HintSnapshot,
 * }}
 */
export function createHintState(options = {}) {
  const now = options.now ?? (() => Date.now());
  const humanApprovalWaitMs = options.humanApprovalWaitMs ?? 300000;
  const humanInputWaitMs = options.humanInputWaitMs ?? 60000;

  /** @type {AgentState} */
  let state = 'running';
  /** @type {number} */
  let since = now();
  /** @type {string | undefined} */
  let reason;
  /** @type {Map<string, { name: string, startedAt: number }>} */
  let openTools = new Map();

  let callIndex = 0;
  let epoch = 0;
  let turnIndex = 0;
  /** 上一次请求看到的逻辑输入条数；没有 compact 事件时靠它识别上下文重写。 */
  let lastLogicalCount;
  /** 本轮是否已由 compact/tree 事件记过重写，避免与条数回落双重计数。 */
  let rewriteCounted = false;
  /**
   * `undefined` when no user run is open, `null` when one is open but its opening request has not
   * been numbered yet, otherwise the call ordinal of that run's first request.
   *
   * The ordinal is chosen at the request boundary rather than at `onRunStart` because Pi opens the
   * run before the request exists -- and it is then kept, so the second request of the same run
   * cannot be mistaken for its first.
   *
   * @type {number | null | undefined}
   */
  let runOpenedAt;
  let compactionArmed = false;
  let branchArmed = false;
  /** @type {'human_approval' | 'human_input' | undefined} */
  let resumedFrom;
  /** @type {number | undefined} */
  let observedWaitMs;
  /** @type {{ kind: string, startedAt: number, approval: boolean } | undefined} */
  let openPrompt;
  /** @type {string | undefined} */
  let lastToolName;
  /** @type {'fork' | 'spawn' | undefined} */
  let relation;
  /** @type {string | undefined} */
  let parentSessionId;
  /** @type {number | undefined} */
  let forkPoint;
  /** @type {'sync' | 'async' | undefined} */
  let join;
  /** Agent type is fixed by validated plugin configuration for the life of this instance. */
  const agentType = typeof options.agentType === 'string' && options.agentType !== ''
    ? options.agentType
    : DEFAULT_AGENT_TYPE;

  /**
   * @param {AgentState} next state to enter.
   * @param {{ at?: number, reason?: string, tools?: Array<{ name: string, call_id?: string, startedAt?: number }> }} [detail]
   *   `at` is the event timestamp when the event carries one; entering a state that is already
   *   current leaves `since` alone so that the published `state_since_ms` keeps meaning "when this
   *   state began" instead of "when we last thought about it".
   */
  function enter(next, detail = {}) {
    const at = typeof detail.at === 'number' && Number.isFinite(detail.at) ? detail.at : now();
    const tools = detail.tools;
    const keepSince = state === next;
    state = next;
    reason = detail.reason;
    if (tools !== undefined) {
      openTools = new Map(tools.map((tool) => [
        tool.call_id ?? `${tool.name}@${tool.startedAt ?? at}`,
        {
          name: tool.name,
          startedAt: tool.startedAt ?? at,
        },
      ]));
    }
    if (!keepSince) since = at;
  }

  /**
   * @returns {Array<{ name: string, call_id?: string, startedAt?: number }> | undefined}
   *   the tool list the protocol expects for the current state.
   */
  function currentTools() {
    if (state !== 'tool' || openTools.size === 0) return undefined;
    return [...openTools.entries()].map(([callId, tool]) => {
      const entry = {
        name: tool.name,
        call_id: callId,
        startedAt: tool.startedAt,
      };
      return /** @type {{ name: string, call_id?: string, startedAt?: number }} */ (entry);
    });
  }

  return {
    onSessionStart(event = {}) {
      // Only a new or forked conversation starts at zero. A resumed Pi session keeps its
      // session-wide request ordinal and context generation across extension processes.
      const recovered = ['startup', 'resume', 'reload'].includes(event.reason ?? '')
        ? event.recovered : undefined;
      callIndex = recovered?.callIndex ?? 0;
      epoch = recovered?.epoch ?? 0;
      // 新的会话/恢复：条数基线与去重标记都归零，避免拿上一个会话的条数比降。
      lastLogicalCount = undefined;
      rewriteCounted = false;
      turnIndex = 0;
      runOpenedAt = undefined;
      compactionArmed = false;
      branchArmed = false;
      resumedFrom = undefined;
      observedWaitMs = undefined;
      openPrompt = undefined;
      lastToolName = undefined;
      parentSessionId = event.reason === 'fork'
        && typeof event.parentSessionId === 'string' && event.parentSessionId !== ''
        ? event.parentSessionId
        : recovered?.parentSessionId;
      // Pi 1.1 exposes fork as a session lifecycle event, but has no native spawn or handoff
      // session mechanism. A deployment that creates this session on someone else's behalf says
      // so through `lineage`, which is the only way a spawn can be reported truthfully here --
      // guessing one from the environment would fabricate an ancestry.
      relation = parentSessionId === undefined ? undefined : 'fork';
      const point = event.reason === 'fork' ? event.forkPoint : recovered?.forkPoint;
      forkPoint = relation === 'fork' && Number.isSafeInteger(point) && point >= 0
        ? point
        : undefined;
      join = undefined;
      const declared = event.lineage;
      if (declared !== null && typeof declared === 'object' && typeof declared.relation === 'string'
        && DECLARED_RELATIONS.includes(declared.relation)) {
        relation = declared.relation;
        if (typeof declared.parent_session_id === 'string' && declared.parent_session_id !== '') {
          parentSessionId = declared.parent_session_id;
        }
        if (relation === 'fork' && Number.isSafeInteger(declared.fork_point) && declared.fork_point >= 0) {
          forkPoint = declared.fork_point;
        }
        if (relation === 'spawn') {
          join = declared.join === 'async' ? 'async' : 'sync';
          forkPoint = undefined;
        }
      }
      state = 'running';
      reason = undefined;
      openTools = new Map();
      since = typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : now();
    },

    onRunStart(at) {
      // The only per-run boundary: `turn_start` fires again for every LLM call inside the run,
      // so clearing here would erase the tool and wait markers exactly when the request that
      // needs them is about to be built.
      turnIndex = 0;
      resumedFrom = undefined;
      observedWaitMs = undefined;
      lastToolName = undefined;
      // The run is declared open, but its first call ordinal is not chosen here: Pi opens a run
      // before the request exists, so only the request boundary can number it. `beginRequest`
      // fills the ordinal in and, crucially, keeps it -- which is what stops the second request
      // of a run from being mistaken for its first.
      runOpenedAt = null;
      // `resume` is a live state, not an event: the request that follows a human interaction
      // reports it until that request has been built (see markResumeReported), so recreating the
      // state here must not silently downgrade it to `running`.
      enter(state === 'tool' ? 'tool' : state === 'resume' ? 'resume' : 'running', { at });
    },

    onTurnStart(event = {}) {
      if (typeof event.turnIndex === 'number' && Number.isFinite(event.turnIndex)) {
        turnIndex = event.turnIndex;
      } else {
        turnIndex += 1;
      }
      // Pi already knows which call this is; the ordinal is recorded here so the stats layer can
      // attribute "what ran between call N and N+1", while `callIndex` stays owned by
      // `beginRequest` -- the two must not drift into each other's meaning.
    },

    onToolStart(event = {}) {
      const name = typeof event.toolName === 'string' && event.toolName !== '' ? event.toolName : 'unknown';
      const callId = typeof event.toolCallId === 'string' && event.toolCallId !== '' ? event.toolCallId : undefined;
      const at = typeof event.at === 'number' ? event.at : now();
      lastToolName = name;
      openTools.set(callId ?? `${name}@${at}`, {
        name,
        startedAt: at,
      });
      enter('tool', {
        at,
        reason: 'await_tool',
        tools: [...openTools.entries()].map(([key, tool]) => ({
          name: tool.name,
          call_id: key,
          startedAt: tool.startedAt,
        })),
      });
      // The request that follows the human interaction has already reported it, and the agent
      // has now taken a new action, so "just resumed from a wait" stops being the salient fact.
      // Retiring the marker here (rather than on a build, which must stay pure) is what keeps a
      // long tool loop from re-reporting a resume on every remaining turn of the run.
      resumedFrom = undefined;
      observedWaitMs = undefined;
    },

    onToolEnd(event = {}) {
      const name = typeof event.toolName === 'string' && event.toolName !== '' ? event.toolName : undefined;
      const callId = typeof event.toolCallId === 'string' && event.toolCallId !== '' ? event.toolCallId : undefined;
      const at = typeof event.at === 'number' ? event.at : now();
      if (callId !== undefined && openTools.has(callId)) {
        openTools.delete(callId);
      } else if (name !== undefined) {
        for (const [key, tool] of openTools) {
          if (tool.name === name) {
            openTools.delete(key);
            break;
          }
        }
      } else {
        openTools.clear();
      }
      // Parallel tool calls: only the last result ends the wait. Reporting `running` after the
      // first of two results would tell the engine the agent is producing tokens while it is
      // still blocked, which is the exact inversion the source document warns about.
      if (openTools.size === 0) enter('running', { at });
    },

    onBeforeCompact() {
      compactionArmed = true;
    },

    onCompactDone(at) {
      compactionArmed = false;
      // Only a successful compaction rewrote the conversation, so only it advances the epoch.
      // A failed one changed nothing and must not announce a rewrite that never happened.
      epoch += 1;
      rewriteCounted = true;
      enter('running', { at });
    },

    /**
     * 请求边界记录本轮逻辑输入条数，回落即视为上下文被重写（epoch +1）。
     *
     * 真机上 Pi 的溢出恢复会直接裁掉旧消息，且**不派发 `session_compact`**；只靠事件会让
     * epoch 永远停在 0。事件优先：同一轮里已经由 compact/tree 记过一次时，这里不再重复计。
     *
     * @param {number} count 本轮 [system?] + messages 的条数。
     * @returns {boolean} 是否因为回落而 +1。
     */
    noteLogicalCount(count) {
      if (!Number.isSafeInteger(count) || count < 0) return false;
      const shrank = lastLogicalCount !== undefined && count < lastLogicalCount;
      lastLogicalCount = count;
      if (rewriteCounted) {
        // 这一轮的重写已经由事件记过账，消费掉标记即可。
        rewriteCounted = false;
        return false;
      }
      if (shrank) {
        epoch += 1;
        return true;
      }
      return false;
    },

    onCompactFailed() {
      compactionArmed = false;
      enter('running');
    },

    onBeforeTree(event = {}) {
      // Only a branch summarization produces a special request; plain navigation does not.
      if (event.preparation?.userWantsSummary === true) branchArmed = true;
    },

    onTree(at) {
      branchArmed = false;
      // Navigating the tree replaces the conversation the engine was caching, so the context
      // generation changes for the same reason a compaction changes it.
      epoch += 1;
      rewriteCounted = true;
      enter('running', { at });
    },

    onPauseStart(event = {}) {
      const kind = typeof event.kind === 'string' ? event.kind : 'custom';
      const at = typeof event.at === 'number' ? event.at : now();
      // `confirm` is the approval gate (ctx.ui.confirm); every other kind is still a human
      // interaction that idles the session, but the engine's expectation differs: an approval
      // has a workflow behind it, a stray input prompt does not.
      const approval = kind === 'confirm';
      openPrompt = { kind, startedAt: at, approval };
      enter('pause', { at, reason: approval ? 'human_approval' : 'human_input' });
    },

    onPauseEnd(event = {}) {
      const at = typeof event.at === 'number' ? event.at : now();
      const prompt = openPrompt;
      if (prompt !== undefined) {
        const elapsed = at - prompt.startedAt;
        observedWaitMs = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
      }
      const kind = typeof event.kind === 'string' ? event.kind : prompt?.kind;
      openPrompt = undefined;
      resumedFrom = kind === 'confirm' || prompt?.approval === true ? 'human_approval' : 'human_input';
      // Enter `resume` rather than `running`: a consumer that only sees request headers cannot
      // tell "the agent kept working" from "the agent was just let go by a person", and that is
      // exactly the distinction the engine ranks on. The state persists until the request it
      // describes has been emitted (markResumeReported), then falls back to `running`.
      enter('resume', { at, reason: resumedFrom });
    },

    onSuspend(at) {
      // Upgrading a pause to a suspend is an observation, not a guess: the wait has been open
      // past the configured threshold, which is the condition the source document gives for
      // writing a checkpoint. Returns whether this call actually changed the state, so the
      // caller knows whether there is a transition to report.
      if (state !== 'pause') return false;
      enter('suspend', {
        at,
        reason: 'checkpoint',
        tools: currentTools(),
      });
      return true;
    },

    onSettled(at) {
      runOpenedAt = undefined;
      // 会话级 finalize：run 结束 ≠ 会话结束。settle 只是回到空闲，消费者不应据此
      // 释放会话资源（那是 finalize 的含义，见 onShutdown）。留在 running——若已经
      // 是 running 则连 since 都不动（enter 的 keepSince），事件签名不变化也就不发新事件。
      // `resume` 是一次性边且尚未上报时不能在这里被覆盖，与 onRunStart 的处理同理。
      if (state !== 'resume') enter('running', { at });
    },

    onShutdown(at) {
      runOpenedAt = undefined;
      compactionArmed = false;
      branchArmed = false;
      openPrompt = undefined;
      // 会话级 finalize：整个会话关闭才 finalize，一个会话至多这一次。
      enter('finalize', { at });
    },

    beginRequest() {
      // The call ordinal is a property of "a provider request was sent", so it is advanced by
      // the caller at the request boundary and handed to the builder as an input. That keeps
      // the builder a pure function of its arguments while the counter remains monotone even
      // when a request is retried by the host.
      callIndex += 1;
      // The first request after a user prompt is that run's opening call; the ordinal is recorded
      // once and kept, so a continuation can never claim to be an opening.
      if (runOpenedAt === null) runOpenedAt = callIndex;
      return callIndex;
    },

    markResumeReported() {
      resumedFrom = undefined;
      observedWaitMs = undefined;
      // The request that described the resume has been built, so the agent is simply running
      // again: one report per human interaction, not a sticky state.
      if (state === 'resume') enter('running', {});
    },

    snapshot() {
      const tools = currentTools();
      /** @type {AgentStatus} */
      const status = {
        state,
        since,
        reason: state === 'running' || state === 'finalize' ? undefined : reason,
        ...(tools === undefined ? {} : { tools }),
      };
      return Object.freeze({
        status: Object.freeze(status),
        callIndex,
        epoch,
        turnIndex,
        // A run is open until it settles or the runtime shuts down, and its opening call is
        // numbered the first time a request is built inside it.
        inRun: runOpenedAt !== undefined,
        runOpenedAt: runOpenedAt ?? undefined,
        compactionArmed,
        branchArmed,
        resumedFrom,
        observedWaitMs,
        expectedWaitMs: resumedFrom === 'human_approval'
          ? humanApprovalWaitMs
          : resumedFrom === 'human_input' ? humanInputWaitMs
            : openPrompt?.approval === true ? humanApprovalWaitMs
              : openPrompt !== undefined ? humanInputWaitMs : undefined,
        waitStartedAt: openPrompt?.startedAt,
        lastToolName,
        openingRequest: runOpenedAt !== undefined && runOpenedAt === callIndex,
        relation,
        forkPoint,
        join,
        parentSessionId,
        agentType,
      });
    },
  };
}

export { STATUS_REASONS as HINT_STATUS_REASONS };

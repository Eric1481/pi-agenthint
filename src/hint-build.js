/**
 * Pure construction of the AgentHint v2 object, and its `X-Agent-Hint` encoding.
 *
 * 《Agent Hint 字段&实现定义》 §1 defines the wire form: the JSON below, serialized as UTF-8 and
 * encoded as base64url, placed in the `X-Agent-Hint` HTTP header of the model request the agent
 * was going to send anyway. Nothing is added to the request body, so no other component's
 * payload field can be disturbed by this plugin.
 *
 *   {
 *     session: { session_id, parent_session_id?, derivation?, agent_type?, call_index?, epoch? },
 *     agent_status?: { state, state_since_ms?, reason?, tools? },
 *     priority?: { level, reason },
 *     strict_priority?: { level, reason },
 *     cache_control?: { type, ttl_s?, range? } | [ ... ],
 *     prediction?: { latency_ms?, remaining_calls?, output_tokens?, interval_ms?,
 *                    remaining_time_ms?, expected_resume_s?, next_action? }
 *   }
 *
 * Everything here is a pure function of its arguments: no clock, no random source, no I/O. That
 * is what lets the tests assert byte-for-byte stability, which is the property several of these
 * fields exist for -- a "stable" field that changed value between two identical requests would
 * destroy the prefix cache the hint is meant to protect.
 *
 * Optional values are emitted only when the caller supplies an observed fact or a qualified
 * statistical estimate. The builder does not narrow the authoritative schema merely because a
 * particular host event lacks a value.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { HINT_HEADER, dropUndefined, fitToBudget, validateAgentHint } from './hint-schema.js';

export { HINT_HEADER };

/**
 * Longest session id that may be published.
 *
 * A session id is an opaque host value that lands in an HTTP header on every request. Pi's ids
 * are short; anything far longer is not an id we should be forwarding, and a gateway with a
 * header limit would reject the whole request rather than the hint. Over-length ids are
 * replaced by a stable digest so the field stays present, stable, and relatively useless to an
 * attacker probing for session enumeration.
 */
export const MAX_SESSION_ID_LENGTH = 128;

/**
 * @param {unknown} value value to summarize.
 * @returns {string} `sha256:<16 hex>` digest of a deterministic serialization.
 */
export function digest(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value), 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * Serialize a value with sorted object keys.
 *
 * JSON.stringify preserves insertion order, so two objects built in a different field order
 * would hash differently while being semantically identical. Every digest published in a hint
 * goes through this function, and the same discipline must hold on the engine side for the
 * digests to be comparable.
 *
 * @param {unknown} value value to serialize.
 * @returns {string} canonical JSON text.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const record = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/**
 * Shorten a session identifier that is too long to publish, keeping it stable.
 *
 * @param {string} sessionId host session id.
 * @returns {string} the id itself, or a digest of it when it exceeds the publishable length.
 */
export function publishableSessionId(sessionId) {
  if (sessionId.length <= MAX_SESSION_ID_LENGTH) return sessionId;
  return `sid:${digest(sessionId).slice('sha256:'.length)}`;
}

/**
 * Encode a built hint for the wire.
 *
 * base64url (RFC 4648 §5, no padding) is what the protocol names, and it is also the only
 * encoding safe to place in an HTTP header unquoted: standard base64's `+`, `/` and `=` are
 * legal in a header value but not in a URL, and gateways that log or forward the header as a
 * query parameter would mangle them.
 *
 * @param {Record<string, unknown>} hint validated hint.
 * @returns {string} the header value.
 */
export function encodeAgentHint(hint) {
  return Buffer.from(JSON.stringify(hint), 'utf8').toString('base64url');
}

/**
 * @param {string} value header value produced by {@link encodeAgentHint}.
 * @returns {Record<string, unknown>} the decoded hint.
 * @throws {Error} when the value is not base64url-encoded JSON.
 */
export function decodeAgentHint(value) {
  const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('X-Agent-Hint is not a JSON object');
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Choose the priority to publish for this request.
 *
 * `reason` is one of the three values the source document names (§2.3), and the level is
 * ordered so that a human who is waiting outranks everything: that request is the one whose
 * latency a person is actually watching.
 *
 * @param {import('./hint-state.js').HintSnapshot} snapshot state at the moment of the request.
 * @returns {{ level: number, reason: string }} the priority, or a zero-level fallback.
 */
/**
 * Two-level priority contract.
 *
 * The consumer only compares `priority.level` against one admission line, so a value outside
 * these two tiers is a claim it cannot honour: three- and four-level scales invite callers to
 * invent distinctions that the scheduling path collapses anyway. Richness lives in `reason`,
 * which stays a free-form audit string.
 *
 * `level >= 3` is the interactive tier (a person is blocked on this request); everything else
 * folds to `1`. Folding legacy values on the way out keeps old and new senders equivalent:
 * 2 → 1 and 4 → 3 land on exactly the side of the line they landed on before.
 */
export const PRIORITY_INTERACTIVE = 3;
export const PRIORITY_BACKGROUND = 1;

/** Fold any level onto the two-level contract (>= the admission line becomes the tier above it). */
export function normalizePriorityLevel(level) {
  return Number.isFinite(level) && level >= PRIORITY_INTERACTIVE
    ? PRIORITY_INTERACTIVE
    : PRIORITY_BACKGROUND;
}

export function derivePriority(snapshot) {
  if (snapshot.resumedFrom !== undefined) {
    return { level: normalizePriorityLevel(4), reason: 'user_waiting' };
  }
  if (snapshot.compactionArmed || snapshot.branchArmed) {
    return { level: normalizePriorityLevel(2), reason: 'background' };
  }
  // The first request of a run is the one a person is waiting on; every later request of the
  // same run is work the agent decided to do by itself. A request sent outside any run belongs
  // to neither case -- it is not something a person is waiting on -- so it never claims the
  // interactive reason. Note that this decides the *reason*, not the tier: a continuation and
  // an unowned request are both non-interactive, and only the explanation differs.
  if (snapshot.openingRequest !== true) {
    return { level: normalizePriorityLevel(2), reason: 'critical_path' };
  }
  return { level: normalizePriorityLevel(3), reason: 'user_waiting' };
}

/**
 * Retention bounds shared with the receiving side (Motor clamps to the same window).
 *
 * A declaration shorter than {@link TTL_MIN_S} cannot be expressed; one longer than
 * {@link TTL_MAX_S} is clamped rather than dropped. Measured behaviour (P3, 2026-10-21): the
 * receiving engine keeps a prefix if and only if `ttl_s` exceeds the idle gap, and **dropping the
 * declaration removes the protection entirely** — a 600 s gap with no declaration hit 0% of the
 * time, while declaring 3600 s hit 99.8%. Clamping therefore strictly dominates returning
 * `undefined`: an over-long gap still gets the longest retention the wire can carry.
 */
export const TTL_MIN_S = 60;
export const TTL_MAX_S = 3600;
/** How much slack to add over the estimated gap: under-estimating means no protection at all. */
export const TTL_SAFETY_FACTOR = 2;

/** Gap assumed when nothing has been observed yet (protocol default). */
export const TTL_FALLBACK_GAP_S = 300;

/**
 * Minimum prefix size the engine can cache, in tokens.
 *
 * The engine stores KV per block (128 tokens on the rigs we measure) and hashes whole blocks; a
 * prefix below one block is never stored, so a retention declaration for it protects nothing.
 * The comparison uses an estimate, so it is deliberately conservative: it only suppresses
 * declarations for prefixes that are clearly below one block.
 */
export const MIN_CACHEABLE_PREFIX_TOKENS = 128;

/** Characters per token assumed for non-CJK text when estimating a prefix size. */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the token count of a message list without a tokenizer.
 *
 * CJK code points count as one token each (they are close to one token per character in the
 * tokenizers we serve), everything else at {@link CHARS_PER_TOKEN}. The estimate is used only to
 * decide whether a prefix can occupy at least one block, never to size a TTL.
 *
 * @param {readonly unknown[]} messages message list in provider order.
 * @returns {number} estimated tokens, never negative.
 */
export function estimatePrefixTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let cjk = 0;
  let other = 0;
  const walk = (value) => {
    if (typeof value === 'string') {
      for (const ch of value) {
        const code = ch.codePointAt(0);
        if (code >= 0x2e80 && code <= 0x9fff) cjk += 1;
        else if (code >= 0xf900 && code <= 0xfaff) cjk += 1;
        else if (code >= 0xff00 && code <= 0xffef) cjk += 1;
        else other += 1;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(messages);
  return cjk + Math.ceil(other / CHARS_PER_TOKEN);
}

/**
 * Estimate how long the prefix will stay usable, from the runtime signals Pi already has.
 *
 * Priority follows the source document (§3.3): the next tool's own expected duration is the most
 * accurate signal, the observed inter-call interval is second, and only then the protocol default.
 * The safety factor is deliberately applied before clamping: a budget that is slightly too large
 * costs quota, one that is too small costs the cache hit entirely. The result is always inside
 * `[TTL_MIN_S, TTL_MAX_S]` — see the note on {@link TTL_MAX_S} for why over-long gaps clamp
 * instead of dropping the declaration.
 *
 * @param {{ toolExpectedDurationS?: number, intervalMs?: number }} [signals] observed runtime facts.
 * @returns {number} retention seconds within the protocol window.
 */
export function estimateTtlS(signals = {}) {
  const toolSeconds = signals.toolExpectedDurationS;
  const interval = signals.intervalMs;
  let gapSeconds;
  if (Number.isFinite(toolSeconds) && toolSeconds > 0) gapSeconds = toolSeconds;
  else if (Number.isFinite(interval) && interval > 0) gapSeconds = interval / 1000;
  else gapSeconds = TTL_FALLBACK_GAP_S;

  const raw = gapSeconds * TTL_SAFETY_FACTOR;
  return Math.min(TTL_MAX_S, Math.max(TTL_MIN_S, Math.round(raw)));
}

/**
 * Build the `cache_control` declaration for this request.
 *
 * `range` describes **this request's logical model input**. Pi keeps the effective system prompt
 * Pi 1.1's `context_with_system` exposes the final logical transcript including the system
 * message. Providers may serialise that message through a leading field (`system`,
 * `instructions`, `systemInstruction`), so AgentHint normalises those wire dialects to one
 * coordinate space: `[systemPrompt, ...context.messages]`.
 *
 * The context-message count is captured from Pi's `context_with_system` event after ordinary
 * context handlers have run. When that event has not supplied a count, the declaration is omitted: a
 * cache range over an unknown input would be a guess about how much KV to hold. Tool schemas are
 * deliberately outside this range because the source protocol defines no coordinate for the
 * provider's separate `tools` field.
 *
 * @param {{ contextMessageCount: number, systemPromptPresent: boolean, cacheTtlS: number }} input
 *   model-input shape and configured TTL.
 * @returns {Array<Record<string, unknown>> | undefined} the declaration, if any.
 */
export function deriveCacheControl(input) {
  const { contextMessageCount, systemPromptPresent, cacheTtlS, prefixTokens } = input;
  if (!Number.isSafeInteger(contextMessageCount) || contextMessageCount < 0) return undefined;
  const logicalMessageCount = contextMessageCount + (systemPromptPresent ? 1 : 0);
  if (logicalMessageCount < 1) return undefined;

  // A prefix shorter than one cache block is never stored, so declaring retention for it asks the
  // engine to keep something that does not exist. Unknown size (no context event) is treated as
  // large enough: refusing to declare on missing telemetry would silently disable retention for
  // every provider that does not report message sizes.
  if (Number.isFinite(prefixTokens) && prefixTokens < MIN_CACHEABLE_PREFIX_TOKENS) return undefined;

  // One breakpoint, at the end of the stable prefix this request actually carries.
  //
  // Two decisions shaped this:
  //   * `pin` is retired. It never had a behaviour of its own on the consuming side (the type was
  //     only logged), while its name promised a hard guarantee no layer could honour. Dynamo
  //     removed its equivalent and the vLLM RFC dropped Pin outright, so the label is gone here
  //     too; a declaration is a retention request, not a lock.
  //   * The second breakpoint earned nothing. The consumer folds an array into "widest end plus
  //     longest explicit TTL", so a shorter entry at the system prompt contributed no behaviour —
  //     it only doubled the bytes and implied a segmentation the pipeline does not implement.
  //
  // `end` is the whole logical input (system prompt included) because the cached unit is the
  // prefix: asking to keep the tail implicitly keeps everything before it.
  if (!(cacheTtlS > 0)) return undefined;
  return [
    {
      type: 'ephemeral',
      ttl_s: cacheTtlS,
      range: { end: logicalMessageCount, unit: 'message' },
    },
  ];
}

/**
 * Build the `prediction` object from the observed distribution.
 *
 * Every member is optional and each is omitted when the samples do not support it, because an
 * estimate the engine schedules on must never be a fabricated zero (§3 of the source document:
 * the sample count decides *whether* a value is sent, and only then which value).
 *
 * @param {{
 *   stats?: Record<string, unknown>,
 *   status: import('./hint-state.js').AgentStatus,
 *   observed?: boolean,
 *   remainingCalls?: number,
 *   remainingTimeMs?: number,
 * }} input observation snapshot and per-request facts.
 * @returns {Record<string, unknown> | undefined} the prediction, or undefined when unsupported.
 */
export function derivePrediction(input) {
  const stats = input.stats ?? {};
  /** @type {Record<string, unknown>} */
  const prediction = {};

  if (typeof stats.latencyMs === 'number') prediction.latency_ms = stats.latencyMs;
  if (typeof stats.outputTokens === 'number') prediction.output_tokens = stats.outputTokens;
  if (typeof stats.intervalMs === 'number') prediction.interval_ms = stats.intervalMs;
  if (typeof input.remainingCalls === 'number') prediction.remaining_calls = input.remainingCalls;
  if (typeof input.remainingTimeMs === 'number') prediction.remaining_time_ms = input.remainingTimeMs;

  const nextAction = deriveNextAction(stats, input.status);
  const result = { ...prediction };
  if (nextAction !== undefined) result.next_action = nextAction;
  if (Object.keys(result).length === 0) return undefined;

  if (input.observed !== true) return undefined;
  return result;
}

/**
 * Predict the next lifecycle state, using only observed facts.
 *
 * Ordered by how certain each case is: a blocked agent -- or one that has just come back from a
 * block -- can only resume; a turn that just ran a tool is very likely to run another (which is
 * why the probability travels with the prediction instead of being implied). A settled run
 * predicts nothing here: finalize is session-level (fires at session close, see hint-state
 * `onShutdown`), so "run finished" no longer implies "next state finalize".
 *
 * @param {Record<string, unknown>} stats observed distribution.
 * @param {import('./hint-state.js').AgentStatus} status current lifecycle state.
 * @returns {Record<string, unknown> | undefined} `next_action`, or undefined when nothing is known.
 */
export function deriveNextAction(stats, status) {
  // 预测用完整生命周期词汇：被卡住的 agent 接下来会回到 running。
  if (status.state === 'pause' || status.state === 'suspend') {
    return { state: 'running' };
  }
  if (stats.nextState !== null && typeof stats.nextState === 'object') {
    const action = /** @type {Record<string, unknown>} */ (stats.nextState);
    if (typeof action.state === 'string') {
      return dropUndefined({
        // `tool` 不再是状态：下一次调工具就是"继续干活"，用 running 表达，
        // 具体调什么由 next_action.tools 说。
        state: action.state === 'tool' || action.state === 'suspend' ? 'running' : action.state,
        prob: typeof action.prob === 'number' ? Number(action.prob.toFixed(2)) : undefined,
      });
    }
  }
  const nextTool = stats.nextTool;
  if (nextTool !== null && typeof nextTool === 'object') {
    const tool = /** @type {Record<string, unknown>} */ (nextTool);
    if (typeof tool.name === 'string' && tool.name !== '') {
      return {
        state: 'running',
        tools: [{ name: tool.name, expected_duration_s: typeof tool.expectedDurationS === 'number' ? tool.expectedDurationS : 0 }],
        prob: typeof tool.prob === 'number' ? Number(tool.prob.toFixed(2)) : undefined,
      };
    }
  }
  return undefined;
}

/**
 * @typedef {object} BuildInput
 * @property {import('./hint-state.js').HintSnapshot} snapshot state machine snapshot.
 * @property {{ sessionId: string, parentSessionId?: string }} identity
 *   resolved identity; `sessionId` is required, because a hint without one is unaddressable.
 * @property {import('./config.js').AgentHintConfig} config resolved agentHint configuration.
 * @property {number} [contextMessageCount] Pi `context_with_system` messages for this request, excluding the
 *   separately held system prompt.
 * @property {boolean} [systemPromptPresent] whether Pi has a non-empty effective system prompt.
 * @property {Record<string, unknown>} [stats] observation snapshot for this session.
 * @property {{ level: number, reason?: string }} [strictPriority] trusted control-plane value.
 * @property {number} [maxBytes] budget override (tests).
 */

/**
 * Build the AgentHint object for one request.
 *
 * Pure: same inputs, byte-identical output. The caller owns the clock, the counters and the
 * session reads, which is what lets the wire tests assert stability directly.
 *
 * @param {BuildInput} input everything the hint depends on.
 * @returns {{ hint?: Record<string, unknown>, skipped?: string }} the hint, or why none was built.
 */
export function buildAgentHint(input) {
  const { snapshot, identity, config } = input;
  const maxBytes = input.maxBytes ?? undefined;

  // RFC §1.3 / §3.3.5: auxiliary requests (the compaction summary, session titles) carry no
  // hint at all -- they are not on the session's critical path, and decorating them just
  // makes the engine track metadata for a request nobody schedules. Pi arms
  // `session_before_compact` before issuing the summarization request and disarms on
  // `session_compact` / `session_compact_failed`, so the armed window IS the auxiliary
  // request window. The earlier behaviour only suppressed `cache_control` here, which still
  // published session/agent_status/priority on a request the RFC exempts.
  if (snapshot.compactionArmed === true) {
    return { skipped: 'auxiliary request (compaction window, RFC §1.3: no hint)' };
  }

  if (typeof identity.sessionId !== 'string' || identity.sessionId === '') {
    // Without a session there is nothing for the engine to attach the metadata to, so the
    // honest outcome is to send no hint rather than a stub with a synthetic id.
    return { skipped: 'no session id' };
  }

  /** @type {Record<string, unknown>} */
  const session = {
    session_id: publishableSessionId(identity.sessionId),
  };
  // Lineage is published only when this session really has a parent: `fork` is Pi's own session
  // lifecycle event, while `spawn` can only come from the deployment that created this session.
  const parentId = snapshot.parentSessionId ?? identity.parentSessionId;
  if ((snapshot.relation === 'fork' || snapshot.relation === 'spawn')
    && typeof parentId === 'string' && parentId !== '') {
    session.parent_session_id = publishableSessionId(parentId);
    session.derivation = snapshot.relation === 'spawn'
      ? { relation: 'spawn', join: snapshot.join ?? 'sync' }
      : dropUndefined({ relation: 'fork', fork_point: snapshot.forkPoint });
  }
  if (typeof snapshot.agentType === 'string' && snapshot.agentType !== '') session.agent_type = snapshot.agentType;
  if (snapshot.callIndex >= 1) session.call_index = snapshot.callIndex;
  session.epoch = snapshot.epoch;

  /** @type {Record<string, unknown>} */
  const hint = { session };

  const status = snapshot.status;
  // `agent_status` 只带 state 与 state_since_ms：reason/tools 是排障细节，不占 header 预算。
  // 内部 `tool`/`suspend` 都不是对外状态——按简化字段 RFC §3.3.2 折叠表，两者在消费侧
  // 都是"在等外部事件"（工具返回、人等审批），出口一律折成 `pause`；`running` 只表示
  // 本地还在生成/计算。
  const wireState = status.state === 'suspend' || status.state === 'tool'
    ? 'pause'
    : status.state;
  /** @type {Record<string, unknown>} */
  const agentStatus = { state: wireState };
  if (typeof status.since === 'number' && Number.isFinite(status.since)) agentStatus.state_since_ms = status.since;
  hint.agent_status = agentStatus;

  if (config.priority === true) hint.priority = dropUndefined(derivePriority(snapshot));

  // The hard priority is never derived here: the source document is explicit that an ordinary
  // agent does not set it and that it is injected by a trusted control plane. When no such
  // injection is present the field is absent -- publishing a self-assigned strict priority would
  // hand every agent the power to preempt the queue.
  if (config.strictPriority === true && input.strictPriority !== undefined) {
    hint.strict_priority = dropUndefined({
      level: input.strictPriority.level,
      reason: input.strictPriority.reason,
    });
  }

  if (config.cacheControl === true && snapshot.compactionArmed !== true && snapshot.branchArmed !== true) {
    // A configured TTL is an explicit override; otherwise derive one from what has been observed.
    const ttlS = config.cacheTtlS === null
      ? estimateTtlS({
          toolExpectedDurationS: input.stats?.nextTool?.expectedDurationS,
          intervalMs: input.stats?.intervalMs,
        })
      : config.cacheTtlS;
    const control = deriveCacheControl({
      contextMessageCount: input.contextMessageCount,
      systemPromptPresent: input.systemPromptPresent === true,
      cacheTtlS: ttlS ?? 0,
      prefixTokens: input.prefixTokens,
    });
    if (control !== undefined) hint.cache_control = control;
  }

  if (config.prediction === true) {
    const prediction = derivePrediction({
      stats: input.stats,
      status,
      // A window that exists is not the same as a window with enough samples in it; the stats
      // layer decides which metrics survive, and this flag only says whether it was consulted.
      observed: input.stats !== undefined,
      remainingCalls: status.state === 'finalize' ? 0 : input.stats?.remainingCalls,
      remainingTimeMs: status.state === 'finalize' ? 0 : input.stats?.remainingTimeMs,
    });
    if (prediction !== undefined) hint.prediction = prediction;
  }

  const cleaned = dropUndefined(hint);
  const violations = validateAgentHint(cleaned);
  if (violations.length > 0) {
    // A hint that fails its own protocol would burn the one advisory channel it has, and the
    // gateway's rejection reason would be invisible from here. Sending nothing is strictly
    // better, and the caller reports the reason.
    return { skipped: `protocol violation: ${violations[0]}` };
  }

  const sizeOf = (value) => Buffer.byteLength(encodeAgentHint(value), 'utf8');
  const fitted = fitToBudget(cleaned, sizeOf, maxBytes);
  if (fitted === undefined) return { skipped: 'over size budget' };
  return { hint: fitted.hint };
}

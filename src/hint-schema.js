/**
 * AgentHint v2 protocol vocabulary, validation and size budget.
 *
 * The single source of truth for what this plugin is allowed to publish. Ported from
 * 《Agent Hint 字段&实现定义》 §1-§2, which is the only normative document for the v2 wire
 * shape: a base64url-encoded UTF-8 JSON object carried in the `X-Agent-Hint` HTTP header of
 * the normal model request.
 *
 *   interface AgentHint {
 *     session: SessionHint;
 *     agent_status?: AgentStatus;
 *     priority?: PriorityHint;
 *     strict_priority?: PriorityHint;
 *     cache_control?: CacheControlHint | CacheControlHint[];
 *     prediction?: PredictionHint;
 *   }
 *
 * Two rules shape this module:
 *
 * 1. **Vocabulary lives here, once.** The builder, the guard and the tests all read these
 *    tables, so a value that is not in the published word list cannot reach the wire by
 *    accident.
 * 2. **The session block is not droppable.** `session` is the only required member of the
 *    schema; every other group is optional and therefore eligible for the budget ladder. A
 *    hint without a session would be unaddressable metadata, so if even the reduced shape
 *    does not fit, the honest answer is to send nothing.
 */

/** HTTP header carrying the encoded hint. Fixed by the protocol; not configurable. */
export const HINT_HEADER = 'X-Agent-Hint';

/**
 * Upper bound on the encoded hint, in bytes.
 *
 * A hint rides on every request, so its cost is paid on every call while its benefit is
 * probabilistic. 4 KiB is far above the ~300 bytes a full hint needs and still small enough
 * that an accidental field blow-up is caught by a test rather than by a provider's header
 * limit. Exceeding the budget degrades (see {@link fitToBudget}) instead of failing.
 */
export const MAX_HINT_BYTES = 4096;

/** Derivation values this Pi integration can actually observe and publish. */
export const DERIVATION_RELATIONS = ['fork'];

/**
 * Values `agent_status.state` and `prediction.next_action.state` may take.
 *
 * Deliberately NOT the host's own status vocabulary: DSH's `agent/status` only knows
 * `idle | running`, and the source document is explicit that its `tool`/`pause`/`suspend`/
 * `finalize` are AgentHint states that must not be conflated with the host's. `idle` in
 * particular is not this protocol's `finalize`.
 */
export const AGENT_STATES = ['running', 'tool', 'pause', 'suspend', 'finalize'];

/** Values `cache_control[].type` may take. */
export const CACHE_CONTROL_TYPES = ['pin', 'ephemeral'];

/** Values `cache_control[].range.unit` may take (the default is `message`, hence optional). */
export const CACHE_RANGE_UNITS = ['message', 'token'];

/**
 * Reasons this plugin may state for a state it derived.
 *
 * The protocol leaves `reason` free-form; this list is what *this* plugin is allowed to produce,
 * and the builder is written so that no other value can reach the wire. Validation stays
 * permissive about the field itself, because a gateway-side reason is not our vocabulary to
 * police.
 */
export const STATUS_REASONS = ['await_tool', 'human_approval', 'human_input', 'checkpoint'];

/**
 * Reasons this plugin may state for a priority it derived (§2.3 of the source document names
 * exactly these three).
 */
export const PRIORITY_REASONS = ['user_waiting', 'critical_path', 'background'];

/**
 * Number of distinct top-level members, used by tests to keep the shape honest.
 * Kept as documentation-as-code: the protocol has six optional/required members.
 */
export const HINT_MEMBERS = ['session', 'agent_status', 'priority', 'strict_priority', 'cache_control', 'prediction'];

/**
 * @param {unknown} value candidate.
 * @returns {boolean} true when the value is a non-empty string.
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * @param {unknown} value candidate.
 * @returns {boolean} true when the value is a finite, non-negative number.
 */
function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * @param {unknown} value candidate.
 * @returns {boolean} true when the value is a plain (non-array, non-null) object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a built hint against the rules the gateway will apply.
 *
 * This is the plugin applying the contract to itself before the engine can reject it: a hint
 * that violates its own protocol burns the one advisory channel it has, and a gateway that
 * silently drops malformed hints would make the failure invisible.
 *
 * Only rules that are decidable from the published schema and Pi's supported producer profile
 * are enforced. Protocol values for mechanisms Pi does not expose are rejected here so this
 * integration cannot accidentally claim that such a mechanism ran.
 *
 * @param {unknown} hint candidate hint.
 * @returns {string[]} violations; an empty array means the hint may be published.
 */
export function validateAgentHint(hint) {
  if (!isPlainObject(hint)) return ['hint must be an object'];
  const record = /** @type {Record<string, unknown>} */ (hint);
  /** @type {string[]} */
  const violations = [];
  const fail = (rule) => violations.push(rule);

  for (const key of Object.keys(record)) {
    if (!HINT_MEMBERS.includes(key)) fail(`unknown member ${JSON.stringify(key)}`);
  }

  const session = record.session;
  if (!isPlainObject(session)) {
    fail('session is required and must be an object');
  } else {
    const block = /** @type {Record<string, unknown>} */ (session);
    if (!isNonEmptyString(block.session_id)) fail('session.session_id must be a non-empty string');
    if (block.parent_session_id !== undefined && block.parent_session_id !== null
      && !isNonEmptyString(block.parent_session_id)) {
      fail('session.parent_session_id must be a non-empty string or null');
    }
    if (block.agent_type !== undefined && !isNonEmptyString(block.agent_type)) {
      fail('session.agent_type must be a non-empty string');
    }
    if (block.call_index !== undefined
      && (!Number.isSafeInteger(block.call_index) || /** @type {number} */ (block.call_index) < 1)) {
      fail('session.call_index must be an integer >= 1');
    }
    if (block.epoch !== undefined
      && (!Number.isSafeInteger(block.epoch) || /** @type {number} */ (block.epoch) < 0)) {
      fail('session.epoch must be an integer >= 0');
    }
    const derivation = block.derivation;
    if (derivation !== undefined) {
      if (!isPlainObject(derivation)) {
        fail('session.derivation must be an object');
      } else {
        const detail = /** @type {Record<string, unknown>} */ (derivation);
        if (!DERIVATION_RELATIONS.includes(/** @type {string} */ (detail.relation))) {
          fail('session.derivation.relation must be fork');
        }
        if (detail.join !== undefined) {
          fail('session.derivation.join is unsupported by Pi');
        }
        if (detail.fork_point !== undefined && !isNonNegativeNumber(detail.fork_point)) {
          fail('session.derivation.fork_point must be a non-negative number');
        }
        // `fork_point` only has a meaning for a fork.
        if (detail.fork_point !== undefined && detail.relation !== 'fork') {
          fail('session.derivation.fork_point is only defined for relation "fork"');
        }
      }
    }
  }

  const status = record.agent_status;
  if (status !== undefined) {
    if (!isPlainObject(status)) {
      fail('agent_status must be an object');
    } else {
      const block = /** @type {Record<string, unknown>} */ (status);
      if (!AGENT_STATES.includes(/** @type {string} */ (block.state))) {
        fail('agent_status.state is not a known value');
      }
      if (block.state_since_ms !== undefined && !isNonNegativeNumber(block.state_since_ms)) {
        fail('agent_status.state_since_ms must be a non-negative number');
      }
      if (block.reason !== undefined && !isNonEmptyString(block.reason)) {
        fail('agent_status.reason must be a non-empty string');
      }
      if (block.tools !== undefined) {
        if (!Array.isArray(block.tools) || block.tools.length === 0) {
          fail('agent_status.tools must be a non-empty array when present');
        } else {
          block.tools.forEach((tool, index) => {
            if (!isPlainObject(tool) || !isNonEmptyString(/** @type {Record<string, unknown>} */ (tool).name)) {
              fail(`agent_status.tools[${index}].name must be a non-empty string`);
              return;
            }
            const item = /** @type {Record<string, unknown>} */ (tool);
            if (item.call_id !== undefined && !isNonEmptyString(item.call_id)) {
              fail(`agent_status.tools[${index}].call_id must be a non-empty string`);
            }
          });
        }
      }
    }
  }

  for (const member of ['priority', 'strict_priority']) {
    const value = record[member];
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      fail(`${member} must be an object`);
      continue;
    }
    const block = /** @type {Record<string, unknown>} */ (value);
    if (!Number.isFinite(block.level)) fail(`${member}.level must be a number`);
    if (block.reason !== undefined && !isNonEmptyString(block.reason)) {
      fail(`${member}.reason must be a non-empty string`);
    }
  }

  const cacheControl = record.cache_control;
  if (cacheControl !== undefined) {
    const entries = Array.isArray(cacheControl) ? cacheControl : [cacheControl];
    if (entries.length === 0) fail('cache_control must not be an empty array');
    entries.forEach((entry, index) => {
      const path = Array.isArray(cacheControl) ? `cache_control[${index}]` : 'cache_control';
      if (!isPlainObject(entry)) {
        fail(`${path} must be an object`);
        return;
      }
      const block = /** @type {Record<string, unknown>} */ (entry);
      if (!CACHE_CONTROL_TYPES.includes(/** @type {string} */ (block.type))) {
        fail(`${path}.type must be pin | ephemeral`);
      }
      if (block.ttl_s !== undefined && !isNonNegativeNumber(block.ttl_s)) {
        fail(`${path}.ttl_s must be a non-negative number`);
      }
      const range = block.range;
      if (range !== undefined) {
        if (!isPlainObject(range)) {
          fail(`${path}.range must be an object`);
          return;
        }
        const span = /** @type {Record<string, unknown>} */ (range);
        if (span.start !== undefined && !isNonNegativeNumber(span.start)) {
          fail(`${path}.range.start must be a non-negative number`);
        }
        if (span.end !== undefined && !isNonNegativeNumber(span.end)) {
          fail(`${path}.range.end must be a non-negative number`);
        }
        if (span.unit !== undefined && !CACHE_RANGE_UNITS.includes(/** @type {string} */ (span.unit))) {
          fail(`${path}.range.unit must be message | token`);
        }
        // An inverted range would be read as "nothing" by a strict gateway and as "the whole
        // session" by a lenient one -- two very different amounts of KV to keep warm.
        if (typeof span.start === 'number' && typeof span.end === 'number' && span.end < span.start) {
          fail(`${path}.range.end must be >= range.start`);
        }
      }
    });
  }

  const prediction = record.prediction;
  if (prediction !== undefined) {
    if (!isPlainObject(prediction)) {
      fail('prediction must be an object');
    } else {
      const block = /** @type {Record<string, unknown>} */ (prediction);
      for (const key of ['latency_ms', 'remaining_calls', 'output_tokens', 'interval_ms', 'remaining_time_ms', 'expected_resume_s']) {
        if (block[key] !== undefined && !isNonNegativeNumber(block[key])) {
          fail(`prediction.${key} must be a non-negative number`);
        }
      }
      const nextAction = block.next_action;
      if (nextAction !== undefined) {
        if (!isPlainObject(nextAction)) {
          fail('prediction.next_action must be an object');
        } else {
          const action = /** @type {Record<string, unknown>} */ (nextAction);
          if (!AGENT_STATES.includes(/** @type {string} */ (action.state))) {
            fail('prediction.next_action.state is not a known value');
          }
          if (action.prob !== undefined
            && (!Number.isFinite(action.prob) || /** @type {number} */ (action.prob) < 0 || /** @type {number} */ (action.prob) > 1)) {
            fail('prediction.next_action.prob must be within 0..1');
          }
          if (action.tools !== undefined) {
            if (!Array.isArray(action.tools) || action.tools.length === 0) {
              fail('prediction.next_action.tools must be a non-empty array when present');
            } else {
              action.tools.forEach((tool, index) => {
                if (!isPlainObject(tool) || !isNonEmptyString(/** @type {Record<string, unknown>} */ (tool).name)) {
                  fail(`prediction.next_action.tools[${index}].name must be a non-empty string`);
                  return;
                }
                const item = /** @type {Record<string, unknown>} */ (tool);
                if (item.expected_duration_s !== undefined && !isNonNegativeNumber(item.expected_duration_s)) {
                  fail(`prediction.next_action.tools[${index}].expected_duration_s must be a non-negative number`);
                }
              });
            }
          }
        }
      }
    }
  }

  return violations;
}

/**
 * @param {Record<string, unknown>} object source object.
 * @returns {Record<string, unknown>} a copy without `undefined` values.
 */
export function dropUndefined(object) {
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Reduce a hint until its encoded form fits the budget.
 *
 * The ladder drops whole optional groups, cheapest-to-lose first, and never touches `session`:
 * the fields a gateway needs to even address the metadata. This is why the reduction is a
 * sequence of deletions rather than a size-driven field picker -- deleting a whole group cannot
 * create a validation violation, so the already-validated shape stays valid at every step.
 *
 * `prediction` goes first: it is the largest group, it is derived from local statistics rather
 * than from protocol facts, and a missing estimate is indistinguishable to the engine from an
 * estimate it decided not to act on.
 *
 * `cache_control` goes LAST — after `agent_status`, i.e. only `session` outranks it. Retention is
 * the one declaration whose loss is unrecoverable: once the declaration is absent the consumer
 * has no retention bias at all, whereas a dropped `agent_status` only costs the consumer one
 * state observation. A dropped declaration is also invisible on the wire, so the retention
 * intent would disappear exactly when the context is largest and retention matters most.
 *
 * @param {Record<string, unknown>} hint validated hint.
 * @param {(value: Record<string, unknown>) => number} sizeOf measures the encoded size.
 * @param {number} [maxBytes] budget.
 * @returns {{ hint: Record<string, unknown>, dropped: string[] } | undefined}
 *   the fitting hint and what was dropped, or undefined when nothing honest fits.
 */
export function fitToBudget(hint, sizeOf, maxBytes = MAX_HINT_BYTES) {
  if (sizeOf(hint) <= maxBytes) return { hint, dropped: [] };

  const dropped = [];
  let current = hint;
  for (const group of ['prediction', 'priority', 'strict_priority', 'agent_status', 'cache_control']) {
    if (current[group] === undefined) continue;
    const next = { ...current };
    delete next[group];
    dropped.push(group);
    current = next;
    if (sizeOf(current) <= maxBytes) return { hint: current, dropped };
  }
  return undefined;
}

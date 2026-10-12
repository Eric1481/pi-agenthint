const DEFAULT_AGENT_TYPE = 'pi-agent';

/**
 * Observation windows for the `prediction` field.
 *
 * 《Agent Hint 字段&实现定义》 §3 says the prediction comes from call and lifecycle telemetry
 * (latency, output tokens, call interval, tool/sub-agent start and end events) aggregated per
 * session and agent type, where the internal distribution is collapsed to a single value per
 * metric before it is sent, and where the sample count exists only to decide *whether* a value
 * may be sent at all.
 *
 * That is what this module implements, and the "whether" is the load-bearing part: 0 remaining
 * calls and *no estimate* are different claims, and an engine that schedules on a fabricated
 * zero would treat a hard problem as a nearly finished one. Below `minSamples` the metric is
 * omitted rather than guessed.
 *
 * Every observation carries its own timestamp. Provider request boundaries, rather than Pi turn
 * boundaries, are authoritative: a Pi turn can contain a tool execution, while the protocol
 * defines latency as one provider exchange and interval as the non-model time before the next
 * provider exchange in the same run.
 */

/** @typedef {'mean' | 'p90' | 'max'} StatsPolicy */

/**
 * @param {readonly number[]} values samples, unsorted.
 * @param {StatsPolicy} policy which single value to report.
 * @returns {number} the collapsed value.
 */
export function aggregate(values, policy) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  if (policy === 'max') return sorted[sorted.length - 1];
  if (policy === 'mean') {
    return sorted.reduce((total, value) => total + value, 0) / sorted.length;
  }
  // p90 by nearest-rank: the smallest sample that is at least as large as 90% of the others.
  // Nearest-rank (rather than interpolated) keeps the reported number a value that was actually
  // observed, which matters when the consumer is sizing a KV reservation.
  const rank = Math.ceil(0.9 * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Create an observation store.
 *
 * The store is bounded per session by `window`: it exists to describe "this session's recent
 * behaviour" to the engine, not to be a metrics system, and an unbounded window would make a
 * long-running session's reported p90 a statement about last week.
 *
 * @param {{ window?: number, policy?: StatsPolicy, minSamples?: number }} [options]
 *   window: samples kept per metric per session; policy: collapse strategy; minSamples: how
 *   many samples a metric needs before it may be published.
 * @returns {{
 *   observeRunStart: (sessionId: string, agentType: string, at: number) => void,
 *   observeNextState: (sessionId: string, state: string) => void,
 *   observeProviderStart: (sessionId: string, at: number) => void,
 *   observeProviderEnd: (sessionId: string, at: number, messageCount?: number) => void,
 *   observeOutputTokens: (sessionId: string, outputTokens?: number) => void,
 *   observeToolStart: (sessionId: string, toolName: string, at: number, callId?: string) => void,
 *   observeToolEnd: (sessionId: string, toolName: string, at: number, callId?: string, durationMs?: number) => void,
 *   observeSettled: (sessionId: string, at?: number) => void,
 *   observeAborted: (sessionId: string) => void,
 *   snapshot: (sessionId: string, agentType?: string, at?: number) => Record<string, unknown>,
 *   forget: (sessionId: string) => void,
 *   size: () => number,
 * }}
 */
export function createHintStats(options = {}) {
  const window = Number.isSafeInteger(options.window) && /** @type {number} */ (options.window) > 0
    ? /** @type {number} */ (options.window)
    : 20;
  const policy = options.policy ?? 'p90';
  const minSamples = Number.isSafeInteger(options.minSamples) && /** @type {number} */ (options.minSamples) >= 1
    ? /** @type {number} */ (options.minSamples)
    : 3;

  /**
   * @typedef {object} SessionStats
     * @property {{ at: number, ordinal: number } | undefined} inFlightProvider active exchange.
     * @property {{ at: number, ordinal: number } | undefined} intervalCandidate completed exchange awaiting the next request in the same run.
     * @property {number | undefined} outputOrdinal     completed exchange whose usage arrives on turn_end.
     * @property {number} providerOrdinal               provider request position in the current run.
     * @property {number[]} messageCounts               payload message counts, for the record.
     * @property {Map<string, { name: string, at: number, ordinal: number }>} openTools in-flight tool calls by id.
   * @property {boolean} settled                      the run has finished, so the next state is known.
   * @property {number} completions                   how many calls produced a usable duration.
   */

  /** @type {Map<string, SessionStats>} */
  const sessions = new Map();
  /** Completed-run and next-action priors, shared by sessions of the same agent type. */
  const profiles = new Map();

  function profile(agentType) {
    let value = profiles.get(agentType);
    if (value === undefined) {
      value = {
        calls: [],
        durations: [],
        callLatencies: new Map(),
        outputs: new Map(),
        intervals: new Map(),
        actions: new Map(),
        toolDurations: new Map(),
      };
      profiles.set(agentType, value);
    }
    return value;
  }

  function callOrdinal(stats) {
    return Math.max(1, stats.providerOrdinal);
  }

  function actionKey(ordinal) {
    return String(Math.max(1, ordinal));
  }

  function toolKey(ordinal, name) {
    return `${Math.max(1, ordinal)}\u0000${name}`;
  }

  function keepProfileWindow(map, key, samples) {
    map.set(key, samples);
    while (map.size > window) map.delete(map.keys().next().value);
  }

  function observeAction(stats, action) {
    const actions = profile(stats.agentType).actions;
    const key = actionKey(callOrdinal(stats));
    const samples = actions.get(key) ?? [];
    samples.push(action);
    trim(samples);
    keepProfileWindow(actions, key, samples);
  }

  /**
   * @param {string} sessionId session key.
   * @returns {SessionStats} the (created on demand) record for a session.
   */
  function record(sessionId) {
    let stats = sessions.get(sessionId);
    if (stats === undefined) {
      stats = {
        inFlightProvider: undefined,
        intervalCandidate: undefined,
        outputOrdinal: undefined,
        providerOrdinal: 0,
        messageCounts: [],
        openTools: new Map(),
        settled: false,
        completions: 0,
        runStartedAt: undefined,
        agentType: DEFAULT_AGENT_TYPE,
      };
      sessions.set(sessionId, stats);
    }
    return stats;
  }

  /**
   * @param {number[]} list sample list to truncate.
   */
  function trim(list) {
    while (list.length > window) list.shift();
  }

  /**
   * @param {readonly number[]} values samples.
   * @returns {number | undefined} collapsed value, or undefined below the sample floor.
   */
  function metric(values) {
    if (values.length < minSamples) return undefined;
    return aggregate(values, policy);
  }

  return {
    observeRunStart(sessionId, agentType, at) {
      const stats = record(sessionId);
      stats.runStartedAt = Number.isFinite(at) ? at : undefined;
      stats.agentType = typeof agentType === 'string' && agentType !== '' ? agentType : DEFAULT_AGENT_TYPE;
      stats.settled = false;
      stats.providerOrdinal = 0;
      stats.inFlightProvider = undefined;
      stats.intervalCandidate = undefined;
      stats.outputOrdinal = undefined;
      stats.openTools.clear();
    },

    observeNextState(sessionId, state) {
      if (!['tool', 'pause', 'suspend', 'finalize'].includes(state)) return;
      const stats = record(sessionId);
      // `suspend` is a later upgrade of an already-observed pause, not a second action selected
      // by the model call. Counting both would bias the prior toward long human waits.
      if (state !== 'suspend') observeAction(stats, { state });
      // A human wait and a finalized run have their own protocol states. Neither may become an
      // ordinary provider interval if a later user action happens to start another request.
      if (state === 'pause' || state === 'suspend' || state === 'finalize') {
        stats.intervalCandidate = undefined;
      }
    },

    observeProviderStart(sessionId, at) {
      if (!Number.isFinite(at)) return;
      const stats = record(sessionId);
      // A new start while another exchange is open means the old request aborted. There is no
      // response boundary, so neither latency nor interval can be measured for it.
      stats.inFlightProvider = undefined;
      if (stats.intervalCandidate !== undefined) {
        const interval = Math.max(0, at - stats.intervalCandidate.at);
        const ordinal = stats.intervalCandidate.ordinal;
        const shared = profile(stats.agentType).intervals;
        const samples = shared.get(actionKey(ordinal)) ?? [];
        samples.push(interval);
        trim(samples);
        keepProfileWindow(shared, actionKey(ordinal), samples);
      }
      stats.intervalCandidate = undefined;
      stats.providerOrdinal += 1;
      stats.inFlightProvider = { at, ordinal: stats.providerOrdinal };
      stats.settled = false;
    },

    observeProviderEnd(sessionId, at, messageCount) {
      const stats = record(sessionId);
      const open = stats.inFlightProvider;
      if (Number.isFinite(at) && open !== undefined && at >= open.at) {
        const latency = Math.max(0, at - open.at);
        const shared = profile(stats.agentType).callLatencies;
        const key = actionKey(open.ordinal);
        const samples = shared.get(key) ?? [];
        samples.push(latency);
        trim(samples);
        keepProfileWindow(shared, key, samples);
        stats.completions += 1;
        stats.inFlightProvider = undefined;
        stats.intervalCandidate = { at, ordinal: open.ordinal };
        stats.outputOrdinal = open.ordinal;
      }
      if (Number.isSafeInteger(messageCount) && /** @type {number} */ (messageCount) >= 0) {
        stats.messageCounts.push(/** @type {number} */ (messageCount));
        trim(stats.messageCounts);
      }
    },

    observeOutputTokens(sessionId, outputTokens) {
      const stats = record(sessionId);
      if (typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0) {
        const ordinal = stats.outputOrdinal;
        if (ordinal === undefined) return;
        const shared = profile(stats.agentType).outputs;
        const key = actionKey(ordinal);
        const samples = shared.get(key) ?? [];
        samples.push(outputTokens);
        trim(samples);
        keepProfileWindow(shared, key, samples);
      }
      stats.outputOrdinal = undefined;
    },

    observeToolStart(sessionId, toolName, at, callId) {
      const stats = record(sessionId);
      const key = typeof callId === 'string' && callId !== '' ? callId : `${toolName}@${at}`;
      const ordinal = callOrdinal(stats);
      stats.openTools.set(key, { name: toolName, at, ordinal });
      // What followed call N is learned under both the agent type and N. Mixing every tool from
      // a session made late answer-producing calls look like early search-producing calls.
      observeAction(stats, { state: 'tool', tool: toolName });
    },

    observeToolEnd(sessionId, toolName, at, callId, durationMs) {
      const stats = record(sessionId);
      for (const [key, open] of stats.openTools) {
        if (typeof callId === 'string' && callId !== '' && key !== callId) continue;
        if (open.name !== toolName && !key.startsWith(`${toolName}@`)) continue;
        // Pi 1.1 measures execute() with a monotonic clock. Prefer that authoritative duration:
        // wall-clock event timestamps can jump and include event-loop dispatch delay. Old session
        // records and tools which never executed do not carry it, so retain the measured fallback.
        const duration = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
          ? durationMs
          : at - open.at;
        if (Number.isFinite(duration) && duration >= 0) {
          const shared = profile(stats.agentType).toolDurations;
          const sharedKey = toolKey(open.ordinal, open.name);
          const sharedDurations = shared.get(sharedKey) ?? [];
          sharedDurations.push(duration);
          trim(sharedDurations);
          keepProfileWindow(shared, sharedKey, sharedDurations);
        }
        stats.openTools.delete(key);
        break;
      }
    },

    observeSettled(sessionId, at) {
      const stats = record(sessionId);
      stats.settled = true;
      observeAction(stats, { state: 'finalize' });
      stats.intervalCandidate = undefined;
      stats.inFlightProvider = undefined;
      const calls = stats.providerOrdinal;
      const duration = typeof stats.runStartedAt === 'number' && Number.isFinite(at) && at >= stats.runStartedAt
        ? at - stats.runStartedAt
        : undefined;
      const learned = profile(stats.agentType);
      learned.calls.push(calls);
      trim(learned.calls);
      if (duration !== undefined) {
        learned.durations.push(duration);
        trim(learned.durations);
      }
    },

    observeAborted(sessionId) {
      const stats = record(sessionId);
      // A cancelled run is a lifecycle fact, but it is not a completed-task sample. In
      // particular, committing its partial call count or duration would bias remaining_calls and
      // remaining_time_ms downward. Completed provider/tool exchanges remain valid observations.
      stats.settled = false;
      stats.intervalCandidate = undefined;
      stats.inFlightProvider = undefined;
      stats.outputOrdinal = undefined;
      stats.openTools.clear();
    },

    snapshot(sessionId, agentType, at) {
      const stats = sessions.get(sessionId);
      if (stats === undefined) {
        return { samples: 0, settled: false, policy, minSamples };
      }

      const learned = profiles.get(agentType ?? stats.agentType);
      const totalCalls = learned === undefined ? undefined : metric(learned.calls);
      const totalDuration = learned === undefined ? undefined : metric(learned.durations);
      const callsInRun = stats.providerOrdinal;
      const ordinal = Math.max(1, callsInRun);
      const ordinalKey = actionKey(ordinal);
      // A metric below the sample floor for this exact call context stays unknown. Falling back
      // to session-wide values mixes planning calls, tool continuations and final answers.
      const latency = metric(learned?.callLatencies.get(ordinalKey) ?? []);
      const outputTokens = metric(learned?.outputs.get(ordinalKey) ?? []);
      const interval = metric(learned?.intervals.get(ordinalKey) ?? []);
      const elapsed = typeof stats.runStartedAt === 'number' && Number.isFinite(at)
        ? Math.max(0, at - stats.runStartedAt)
        : undefined;

      /** @type {{ name: string, expectedDurationS: number, prob: number } | undefined} */
      let nextTool;
      let nextState;
      const actions = learned?.actions.get(actionKey(ordinal)) ?? [];
      if (actions.length >= minSamples) {
        const counts = new Map();
        for (const action of actions) {
          const key = action.state === 'tool' ? `tool\u0000${action.tool}` : action.state;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        let best;
        for (const [key, count] of counts) {
          if (best === undefined || count > best.count) best = { key, count };
        }
        if (best?.key.startsWith('tool\u0000')) {
          const name = best.key.slice('tool\u0000'.length);
          const duration = metric(learned?.toolDurations.get(toolKey(ordinal, name)) ?? []);
          if (duration !== undefined) {
            nextTool = {
              name,
              expectedDurationS: Math.ceil(duration / 1000),
              // Probability is over every observed next action at this call position, not just
              // over the subset of actions that happened to be tools.
              prob: best.count / actions.length,
            };
          }
        } else if (best !== undefined) {
          nextState = { state: best.key, prob: best.count / actions.length };
        }
      }

      return {
        samples: stats.completions,
        policy,
        minSamples,
        settled: stats.settled,
        turnIndex: stats.providerOrdinal,
        ...(latency === undefined ? {} : { latencyMs: Math.ceil(latency) }),
        ...(outputTokens === undefined ? {} : { outputTokens: Math.ceil(outputTokens) }),
        ...(interval === undefined ? {} : { intervalMs: Math.ceil(interval) }),
        ...(totalCalls === undefined ? {} : { remainingCalls: Math.max(0, Math.ceil(totalCalls) - callsInRun) }),
        ...(totalDuration === undefined || elapsed === undefined || latency === undefined
          ? {}
          // The protocol measures from the end of the current call. At request time that end is
          // still in the future, so subtract the learned duration of the call as well as elapsed
          // time. Without a latency estimate the correct value is unknown and stays omitted.
          : { remainingTimeMs: Math.max(0, Math.ceil(totalDuration) - elapsed - Math.ceil(latency)) }),
        ...(nextTool === undefined ? {} : { nextTool }),
        ...(nextState === undefined ? {} : { nextState }),
      };
    },

    forget(sessionId) {
      sessions.delete(sessionId);
    },

    size() {
      return sessions.size;
    },
  };
}

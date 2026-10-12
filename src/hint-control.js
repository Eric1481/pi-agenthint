/**
 * Trusted control-plane input and the asynchronous status-reporting channel.
 *
 * Two things live here because they share one property: neither is derived from the request the
 * agent is sending.
 *
 * 1. `strict_priority` (§2.4 of 《Agent Hint 字段&实现定义》). The source document is explicit
 *    that an ordinary agent does not set the hard priority and that it is injected by a trusted
 *    control plane. Honouring that means this plugin must never *derive* the field; it can only
 *    forward a value the host handed it. When the host hands it nothing, the field is absent --
 *    a self-assigned strict priority would let any agent preempt the queue it is competing for.
 *
 * 2. State events. §4 requires `pause`/`suspend`/`finalize` and the `tool` transitions to be
 *    reported by the agent framework as state changes happen, because those states do not occur
 *    on the request path: an agent blocked on an approval sends no request at all, so there is
 *    no request to ride on. The document leaves the event interface to the implementation; this
 *    channel is that implementation, and it is off unless an endpoint is configured.
 *
 * Both are advisory. Nothing here may block, delay or fail an agent turn: the reporter hands
 * events to a queue and returns, and every failure is counted instead of thrown.
 */

/** Longest accepted strict-priority level. The binding has no published range; a small ceiling
 * keeps a typo from reordering the engine's whole queue. */
const MAX_PRIORITY_LEVEL = 9;

/** Largest number of events kept when the endpoint is unreachable. */
const DEFAULT_QUEUE_LIMIT = 64;

/**
 * Parse the trusted strict-priority binding.
 *
 * Accepted form is `"<level>:<reason>"` (for example `"3:critical_path"`), which is what an
 * environment variable can carry without ambiguity. Anything else is refused rather than
 * coerced: a partially understood hard priority is worse than none, because the engine would
 * act on a number nobody meant.
 *
 * @param {unknown} raw candidate binding, typically an environment variable value.
 * @returns {{ level: number, reason?: string } | undefined} the binding, or undefined.
 */
export function parseStrictPriority(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const [levelText, ...rest] = raw.trim().split(':');
  const level = Number(levelText);
  if (!Number.isSafeInteger(level) || level < 0 || level > MAX_PRIORITY_LEVEL) return undefined;
  const reason = rest.join(':').trim();
  return { level, ...(reason === '' ? {} : { reason }) };
}

/**
 * @param {string} text binding candidate.
 * @returns {string} a short reason why the binding was refused.
 */
function describeRejection(text) {
  const [levelText] = text.trim().split(':');
  const level = Number(levelText);
  if (levelText === undefined || levelText.trim() === '' || Number.isNaN(level)) {
    return 'expected "<level>:<reason>"';
  }
  if (!Number.isSafeInteger(level)) return 'level must be an integer';
  return `level must be within 0..${MAX_PRIORITY_LEVEL}`;
}

/**
 * Resolve the strict priority the host intends to inject.
 *
 * @param {{
 *   enabled?: boolean,
 *   raw?: string | undefined,
 *   injected?: { level: number, reason?: string } | undefined,
 * }} input `raw` is the environment binding, `injected` a value the host passed programmatically.
 * @returns {{ binding?: { level: number, reason?: string }, reason: string }}
 *   `binding` when a valid trusted value exists; `reason` always describes the outcome, so
 *   `/ascend-hint` can say "no control plane" instead of leaving a reader to guess.
 */
export function resolveStrictPriority(input = {}) {
  if (input.injected !== undefined) {
    const injected = input.injected;
    if (Number.isSafeInteger(injected.level) && injected.level >= 0 && injected.level <= MAX_PRIORITY_LEVEL) {
      return {
        binding: { level: injected.level, ...(injected.reason === undefined ? {} : { reason: injected.reason }) },
        reason: 'injected by host',
      };
    }
    return { reason: `host injection refused: level must be within 0..${MAX_PRIORITY_LEVEL}` };
  }
  if (typeof input.raw === 'string' && input.raw.trim() !== '') {
    const binding = parseStrictPriority(input.raw);
    if (binding !== undefined) return { binding, reason: 'environment binding' };
    return { reason: `environment binding refused: ${describeRejection(input.raw)}` };
  }
  return { reason: 'no trusted control plane configured' };
}

/**
 * @param {number} ms delay.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending report must never hold the process open: the agent finishing is the reason the
    // process exists, and an unreachable collector is not.
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Create the status-event reporting channel.
 *
 * The queue is deliberately a single ordered pipeline rather than one per session: the volume is
 * a handful of events per turn, and a per-session fan-out would make "did the collector see the
 * pause before the resume" depend on scheduling. Ordering is part of the meaning of these
 * events, so it is preserved globally and bounded globally.
 *
 * @param {{
 *   enabled?: boolean,
 *   endpoint?: string,
 *   token?: string | (() => string | undefined),
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   queueLimit?: number,
 *   fetchImpl?: typeof fetch,
 *   onSettled?: (result: { ok: boolean, attempts?: number, status?: number, error?: string }) => void,
 * }} [options] `fetchImpl` exists so tests can drive the channel without a socket.
 * @returns {{
 *   send: (hint: Record<string, unknown>) => void,
 *   state: () => Record<string, unknown>,
 *   flush: () => Promise<void>,
 *   stop: () => void,
 * }}
 */
export function createStatusReporter(options = {}) {
  const enabled = options.enabled === true;
  const endpoint = typeof options.endpoint === 'string' ? options.endpoint : '';
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && /** @type {number} */ (options.timeoutMs) > 0
    ? /** @type {number} */ (options.timeoutMs)
    : 3000;
  const maxRetries = Number.isSafeInteger(options.maxRetries) && /** @type {number} */ (options.maxRetries) >= 0
    ? /** @type {number} */ (options.maxRetries)
    : 2;
  const queueLimit = Number.isSafeInteger(options.queueLimit) && /** @type {number} */ (options.queueLimit) > 0
    ? /** @type {number} */ (options.queueLimit)
    : DEFAULT_QUEUE_LIMIT;
  const tokenProvider = typeof options.token === 'function'
    ? options.token
    : () => (typeof options.token === 'string' && options.token !== '' ? options.token : undefined);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const onSettled = options.onSettled;

  // Only an http(s) endpoint is accepted. Anything else (a file path, a `file:` URL, a bare
  // hostname) would either silently do nothing or reach a transport this code did not intend.
  const configured = enabled && endpoint !== '' && /^https?:\/\//i.test(endpoint) && typeof fetchImpl === 'function';

  /** @type {Array<Record<string, unknown>>} */
  const queue = [];
  /** @type {string | undefined} */
  let lastReportedKey;
  const counters = { queued: 0, sent: 0, failed: 0, dropped: 0 };
  /** @type {string | undefined} */
  let lastError;
  /** @type {Promise<void> | undefined} */
  let draining;
  let stopped = false;

  /** @type {Record<string, unknown>} */
  const state = () => ({
    enabled,
    configured,
    endpoint: configured ? endpoint : '',
    queued: queue.length,
    sent: counters.sent,
    failed: counters.failed,
    dropped: counters.dropped,
    ...(lastError === undefined ? {} : { lastError }),
    ...(enabled && endpoint === '' ? { reason: 'no endpoint configured' } : {}),
    ...(enabled && endpoint !== '' && !configured ? { reason: 'endpoint must be an http(s) URL' } : {}),
    ...(!enabled ? { reason: 'reporting disabled' } : {}),
  });

  /**
   * @param {Record<string, unknown>} hint event payload.
   * @returns {void}
   */
  function send(hint) {
    if (!configured || stopped) return;
    // Deduplicate identical consecutive state events: a state that has not changed is not news,
    // and re-sending it would make the collector's ordering assertions meaningless.
    const key = JSON.stringify(hint.agent_status ?? hint);
    if (key === lastReportedKey) return;
    lastReportedKey = key;
    if (queue.length >= queueLimit) {
      // The channel is advisory; when the collector is slower than the agent, dropping the
      // oldest event keeps memory bounded and the newest state -- the one that matters -- fresh.
      queue.shift();
      counters.dropped += 1;
    }
    queue.push(hint);
    counters.queued += 1;
    void drain();
  }

  /**
   * Deliver one event, retrying per configuration.
   *
   * @param {Record<string, unknown>} hint event payload.
   * @returns {Promise<boolean>} whether the collector acknowledged it.
   */
  async function deliver(hint) {
    let attempts = 0;
    while (attempts <= maxRetries) {
      attempts += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        const resolvedToken = tokenProvider();
        const token = typeof resolvedToken === 'string' && resolvedToken !== '' ? resolvedToken : undefined;
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          },
          body: JSON.stringify(hint),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (response.ok) {
          onSettled?.({ ok: true, attempts, status: response.status });
          return true;
        }
        lastError = `collector responded ${response.status}`;
      } catch (error) {
        clearTimeout(timer);
        // The message is kept for the status report; it never contains the token, because the
        // token only ever appears in a header and this records the failure text.
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempts <= maxRetries) await sleep(Math.min(1000, 100 * 2 ** (attempts - 1)));
    }
    onSettled?.({ ok: false, attempts, error: lastError });
    return false;
  }

  /**
   * Deliver every queued event, one at a time, until the queue is empty.
   *
   * Concurrent callers share one pass: a second `drain()` while a delivery is in flight returns
   * the same promise, so the ordering of the events is preserved and no caller can busy-wait on
   * a pass it did not start.
   *
   * @returns {Promise<void>} resolves when the queue is empty (or the channel was stopped).
   */
  function drain() {
    if (draining !== undefined) return draining;
    draining = (async () => {
      try {
        while (queue.length > 0 && !stopped) {
          const hint = /** @type {Record<string, unknown>} */ (queue.shift());
          const delivered = await deliver(hint);
          if (delivered) {
            counters.sent += 1;
          } else {
            counters.failed += 1;
          }
        }
      } finally {
        draining = undefined;
      }
    })();
    return draining;
  }

  return {
    send,
    state,
    async flush() {
      // Drain repeatedly: a `send` that arrives while the last pass is finishing has appended to
      // the queue, and a flush that returned then would make the caller's assertions flaky rather
      // than wrong -- which is worse, because flaky is easy to dismiss.
      for (let guard = 0; guard < 100; guard += 1) {
        await drain();
        if (queue.length === 0 || stopped) break;
      }
    },
    stop() {
      stopped = true;
      queue.length = 0;
    },
  };
}

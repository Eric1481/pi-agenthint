/**
 * Tests for the observation windows behind `prediction`.
 *
 * The load-bearing rule is that a metric is published only when the samples support it: "0
 * remaining calls" and "no estimate" are different claims, and an engine that schedules on a
 * fabricated zero would treat a hard problem as a nearly finished one.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = root;
const { aggregate, createHintStats } = await import(
  pathToFileURL(join(pluginRoot, 'src', 'hint-stats.js')).href
);

function completeProvider(stats, session, start, end, outputTokens) {
  stats.observeProviderStart(session, start);
  stats.observeProviderEnd(session, end);
  stats.observeOutputTokens(session, outputTokens);
}

test('the three collapse policies pick the documented value', () => {
  const values = [10, 20, 30, 40, 100];
  assert.equal(aggregate(values, 'max'), 100);
  assert.equal(aggregate(values, 'mean'), 40);
  // Nearest-rank: the smallest observed sample that covers 90% of the others, so the reported
  // number is always a value that was actually measured.
  assert.equal(aggregate(values, 'p90'), 100);
  assert.equal(aggregate([10, 20, 30, 40], 'p90'), 40);
});

test('an empty distribution collapses to zero rather than NaN', () => {
  assert.equal(aggregate([], 'p90'), 0);
  assert.equal(aggregate([], 'mean'), 0);
});

test('below the sample floor nothing is published at all', () => {
  const stats = createHintStats({ minSamples: 3 });
  for (const [session, output] of [['a', 50], ['b', 60]]) {
    stats.observeRunStart(session, 'researcher', 0);
    completeProvider(stats, session, 0, 100, output);
  }
  stats.observeRunStart('s', 'researcher', 0);
  stats.observeProviderStart('s', 0);
  const snapshot = stats.snapshot('s', 'researcher');
  assert.equal(snapshot.latencyMs, undefined);
  assert.equal(snapshot.outputTokens, undefined);
  assert.equal(snapshot.samples, 0, 'the current session has not completed a provider request');
});

test('once enough samples exist the policy value is published', () => {
  const stats = createHintStats({ minSamples: 2, policy: 'p90' });
  // Two call-1 exchanges and their response-to-call-2 gaps teach the same call context.
  for (const [session, latency, interval, output] of [['a', 100, 400, 40], ['b', 200, 200, 60]]) {
    stats.observeRunStart(session, 'researcher', 0);
    completeProvider(stats, session, 0, latency, output);
    stats.observeProviderStart(session, latency + interval);
  }
  stats.observeRunStart('s', 'researcher', 0);
  stats.observeProviderStart('s', 0);
  const snapshot = stats.snapshot('s', 'researcher');
  assert.equal(snapshot.latencyMs, 200, 'the larger of the two observed durations');
  assert.equal(snapshot.outputTokens, 60);
  assert.equal(snapshot.intervalMs, 400, 'nearest-rank p90 of the two response-to-next-request gaps');
});

test('provider latency excludes tool time while interval includes it', () => {
  const stats = createHintStats({ minSamples: 1 });
  stats.observeRunStart('train', 'researcher', 0);
  completeProvider(stats, 'train', 0, 100, 20);
  stats.observeToolStart('train', 'search', 110, 'tool-1');
  stats.observeToolEnd('train', 'search', 8110, 'tool-1');
  stats.observeProviderStart('train', 8200);

  stats.observeRunStart('next', 'researcher', 9000);
  stats.observeProviderStart('next', 9000);
  const prediction = stats.snapshot('next', 'researcher');
  assert.equal(prediction.latencyMs, 100, 'only the provider exchange is latency');
  assert.equal(prediction.intervalMs, 8100, 'tool execution and orchestration are between calls');
});

test('an unfinished provider request contributes neither a fabricated latency nor an interval', () => {
  const stats = createHintStats({ minSamples: 1 });
  stats.observeRunStart('s', 'researcher', 0);
  stats.observeProviderStart('s', 0);
  stats.observeProviderStart('s', 400);
  stats.observeRunStart('next', 'researcher', 500);
  stats.observeProviderStart('next', 500);
  const snapshot = stats.snapshot('next', 'researcher');
  assert.equal(snapshot.latencyMs, undefined);
  assert.equal(snapshot.intervalMs, undefined);
});

test('an interval belongs to the provider call that ended before it', () => {
  const stats = createHintStats({ minSamples: 1 });
  stats.observeRunStart('train', 'researcher', 0);
  completeProvider(stats, 'train', 0, 100, 20);
  stats.observeProviderStart('train', 5100);
  stats.observeProviderEnd('train', 5200);

  stats.observeRunStart('first', 'researcher', 6000);
  stats.observeProviderStart('first', 6000);
  assert.equal(stats.snapshot('first', 'researcher').intervalMs, 5000);

  stats.observeRunStart('second', 'researcher', 7000);
  stats.observeProviderStart('second', 7000);
  stats.observeProviderStart('second', 7100);
  assert.equal(
    stats.snapshot('second', 'researcher').intervalMs,
    undefined,
    'call 2 has no interval merely because call 1 had one',
  );
});

test('finalize and a new run prevent cross-task intervals', () => {
  const stats = createHintStats({ minSamples: 1 });
  stats.observeRunStart('s', 'researcher', 0);
  completeProvider(stats, 's', 0, 100, 20);
  stats.observeSettled('s', 110);
  stats.observeRunStart('s', 'researcher', 10000);
  stats.observeProviderStart('s', 10000);
  assert.equal(stats.snapshot('s', 'researcher').intervalMs, undefined);
});

test('a human pause does not pollute the ordinary provider interval', () => {
  const stats = createHintStats({ minSamples: 1 });
  stats.observeRunStart('s', 'researcher', 0);
  completeProvider(stats, 's', 0, 100, 20);
  stats.observeNextState('s', 'pause');
  stats.observeProviderStart('s', 600100);

  stats.observeRunStart('next', 'researcher', 700000);
  stats.observeProviderStart('next', 700000);
  assert.equal(stats.snapshot('next', 'researcher').intervalMs, undefined);
});

test('call-context metrics do not fall back to a mixed session distribution', () => {
  const stats = createHintStats({ minSamples: 2, policy: 'p90' });
  stats.observeRunStart('s', 'researcher', 0);
  completeProvider(stats, 's', 0, 100, 20);
  completeProvider(stats, 's', 200, 1200, 90);
  completeProvider(stats, 's', 1300, 3300, 100);

  stats.observeRunStart('next', 'researcher', 4000);
  stats.observeProviderStart('next', 4000);
  const prediction = stats.snapshot('next', 'researcher');
  assert.equal(prediction.latencyMs, undefined, 'call 1 has only one sample');
  assert.equal(prediction.outputTokens, undefined, 'call 2/3 output must not leak into call 1');
});

test('the next action is the tool that most often followed this call ordinal', () => {
  const stats = createHintStats({ minSamples: 2 });
  for (const [session, tool] of [['a', 'read'], ['b', 'read'], ['c', 'grep']]) {
    stats.observeRunStart(session, 'researcher', 0);
    stats.observeProviderStart(session, 0);
    stats.observeToolStart(session, tool, 10, session);
    stats.observeToolEnd(session, tool, 30, session);
  }
  stats.observeRunStart('d', 'researcher', 100);
  stats.observeProviderStart('d', 100);

  const nextTool = stats.snapshot('d', 'researcher').nextTool;
  assert.equal(nextTool.name, 'read');
  assert.ok(Math.abs(nextTool.prob - 2 / 3) < 1e-9, `probability was ${nextTool.prob}`);
  assert.equal(nextTool.expectedDurationS, 1, '20 ms is rounded up to a whole second, never down to zero');
});

test('a tool probability uses every next action at the same call position as its denominator', () => {
  const stats = createHintStats({ minSamples: 2 });
  for (const session of ['a', 'b']) {
    stats.observeRunStart(session, 'researcher', 0);
    stats.observeProviderStart(session, 0);
    stats.observeToolStart(session, 'read', 10, session);
    stats.observeToolEnd(session, 'read', 30, session);
  }
  for (const session of ['c', 'd']) {
    stats.observeRunStart(session, 'researcher', 0);
    stats.observeProviderStart(session, 0);
    stats.observeNextState(session, 'pause');
  }
  stats.observeRunStart('next', 'researcher', 100);
  stats.observeProviderStart('next', 100);
  assert.equal(stats.snapshot('next', 'researcher').nextTool.prob, 0.5);
});

test('next actions are isolated by agent type and call ordinal', () => {
  const stats = createHintStats({ minSamples: 1 });
  stats.observeRunStart('a', 'researcher', 0);
  stats.observeProviderStart('a', 0);
  stats.observeToolStart('a', 'search', 10, 'a1');
  stats.observeToolEnd('a', 'search', 20, 'a1');
  stats.observeProviderStart('a', 30);
  stats.observeToolStart('a', 'summarize', 40, 'a2');
  stats.observeToolEnd('a', 'summarize', 50, 'a2');

  stats.observeRunStart('b', 'writer', 0);
  stats.observeProviderStart('b', 0);
  stats.observeToolStart('b', 'draft', 10, 'b1');
  stats.observeToolEnd('b', 'draft', 20, 'b1');

  stats.observeRunStart('r1', 'researcher', 100);
  stats.observeProviderStart('r1', 100);
  assert.equal(stats.snapshot('r1', 'researcher').nextTool.name, 'search');
  stats.observeProviderStart('r1', 200);
  assert.equal(stats.snapshot('r1', 'researcher').nextTool.name, 'summarize');

  stats.observeRunStart('w1', 'writer', 100);
  stats.observeProviderStart('w1', 100);
  assert.equal(stats.snapshot('w1', 'writer').nextTool.name, 'draft');
});

test('tool durations are reported in whole seconds from observed runs', () => {
  const stats = createHintStats({ minSamples: 1, policy: 'p90' });
  stats.observeToolStart('s', 'web_search', 0, 'a');
  stats.observeToolEnd('s', 'web_search', 8000);
  stats.observeToolStart('s', 'web_search', 10000, 'b');
  stats.observeToolEnd('s', 'web_search', 18000);
  assert.equal(stats.snapshot('s').nextTool.expectedDurationS, 8);
});

test('Pi 1.1 monotonic duration wins over wall-clock event timestamps', () => {
  const stats = createHintStats({ minSamples: 1, policy: 'p90' });
  stats.observeProviderStart('s', 0);
  stats.observeToolStart('s', 'web_search', 1000, 'a');
  stats.observeToolEnd('s', 'web_search', 11000, 'a', 2500);
  assert.equal(stats.snapshot('s').nextTool.expectedDurationS, 3);
});

test('a predicted tool is omitted until its duration has enough completed samples', () => {
  const stats = createHintStats({ minSamples: 2 });
  stats.observeProviderStart('s', 0);
  stats.observeToolStart('s', 'web_search', 10, 'a');
  stats.observeProviderStart('s', 100);
  stats.observeToolStart('s', 'web_search', 110, 'b');
  assert.equal(stats.snapshot('s').nextTool, undefined);
});

test('the window is bounded, so a long session does not report last week', () => {
  const stats = createHintStats({ window: 2, minSamples: 1, policy: 'max' });
  for (const [session, latency] of [['old', 1000], ['recent-a', 100], ['recent-b', 50]]) {
    stats.observeRunStart(session, 'researcher', 0);
    completeProvider(stats, session, 0, latency, 10);
  }
  stats.observeRunStart('s', 'researcher', 0);
  stats.observeProviderStart('s', 0);
  // The 1000 ms sample has aged out of a two-sample window; the maximum of what remains is what
  // the engine is told, because a hint describes this session's recent behaviour.
  assert.equal(stats.snapshot('s', 'researcher').latencyMs, 100);
});

test('call-context profile keys are bounded as well as the samples inside them', () => {
  const stats = createHintStats({ window: 2, minSamples: 1 });
  stats.observeRunStart('train', 'researcher', 0);
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    stats.observeProviderStart('train', ordinal * 100);
    stats.observeToolStart('train', `tool-${ordinal}`, ordinal * 100 + 10, `c${ordinal}`);
    stats.observeToolEnd('train', `tool-${ordinal}`, ordinal * 100 + 20, `c${ordinal}`);
  }

  stats.observeRunStart('next', 'researcher', 1000);
  stats.observeProviderStart('next', 1000);
  assert.equal(stats.snapshot('next', 'researcher').nextTool, undefined, 'the oldest call context was pruned');
});

test('sessions are isolated and can be forgotten', () => {
  const stats = createHintStats({ minSamples: 1 });
  stats.observeRunStart('a', 'researcher', 0);
  completeProvider(stats, 'a', 0, 100, 10);
  assert.equal(stats.snapshot('b').samples, 0);
  assert.equal(stats.size(), 1);
  stats.forget('a');
  assert.equal(stats.size(), 0);
});

test('an unknown session reports the policy it would have used', () => {
  const stats = createHintStats({ policy: 'mean', minSamples: 5 });
  assert.deepEqual(stats.snapshot('nobody'), { samples: 0, settled: false, policy: 'mean', minSamples: 5 });
});

test('completed runs teach positive remaining call and duration priors by agent type', () => {
  const stats = createHintStats({ minSamples: 2, policy: 'mean' });
  for (const [session, start] of [['a', 0], ['b', 1000]]) {
    stats.observeRunStart(session, 'researcher', start);
    completeProvider(stats, session, start, start + 100, 10);
    completeProvider(stats, session, start + 200, start + 300, 10);
    completeProvider(stats, session, start + 400, start + 500, 10);
    stats.observeSettled(session, start + 600);
  }
  stats.observeRunStart('c', 'researcher', 2000);
  stats.observeProviderStart('c', 2000);
  const prediction = stats.snapshot('c', 'researcher', 2100);
  assert.equal(prediction.remainingCalls, 2);
  assert.equal(prediction.remainingTimeMs, 400, 'remaining time starts after the current predicted call ends');
});

test('aborted runs do not train remaining call or duration priors', () => {
  const stats = createHintStats({ minSamples: 1, policy: 'mean' });
  stats.observeRunStart('aborted', 'researcher', 0);
  completeProvider(stats, 'aborted', 0, 100, 10);
  stats.observeAborted('aborted');

  stats.observeRunStart('next', 'researcher', 1000);
  stats.observeProviderStart('next', 1000);
  const prediction = stats.snapshot('next', 'researcher', 1050);
  assert.equal(prediction.remainingCalls, undefined);
  assert.equal(prediction.remainingTimeMs, undefined);
  assert.equal(prediction.latencyMs, 100, 'a completed provider exchange remains a valid latency sample');
});

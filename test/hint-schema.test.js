/**
 * Protocol-level tests for the AgentHint v2 schema.
 *
 * These are the tests the gateway would otherwise run: a hint that violates its own contract
 * burns the one advisory channel the plugin has, and the gateway's rejection reason is invisible
 * from inside the agent, so the contract is enforced locally and first.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = root;
const {
  AGENT_STATES,
  CACHE_CONTROL_TYPES,
  DERIVATION_RELATIONS,
  HINT_HEADER,
  HINT_MEMBERS,
  MAX_HINT_BYTES,
  dropUndefined,
  fitToBudget,
  validateAgentHint,
} = await import(pathToFileURL(join(pluginRoot, 'src', 'hint-schema.js')).href);

/** A minimal valid hint, spread into the negative cases below. */
const valid = () => ({
  session: { session_id: 's-1', agent_type: 'office-agent', call_index: 1, epoch: 0 },
  agent_status: { state: 'running', state_since_ms: 1000 },
  priority: { level: 3, reason: 'user_waiting' },
  cache_control: [{ type: 'pin', range: { end: 1 } }],
  prediction: { remaining_calls: 0, next_action: { state: 'finalize', prob: 0.9 } },
});

test('the vocabulary matches the Pi-supported AgentHint profile', () => {
  assert.equal(HINT_HEADER, 'X-Agent-Hint');
  assert.deepEqual(AGENT_STATES, ['running', 'tool', 'pause', 'suspend', 'finalize']);
  assert.deepEqual(DERIVATION_RELATIONS, ['fork']);
  assert.deepEqual(CACHE_CONTROL_TYPES, ['pin', 'ephemeral']);
  assert.deepEqual(HINT_MEMBERS, ['session', 'agent_status', 'priority', 'strict_priority', 'cache_control', 'prediction']);
});

test('a full, well-formed hint passes validation', () => {
  assert.deepEqual(validateAgentHint(valid()), []);
});

test('session is required and its sub-fields are checked', () => {
  assert.deepEqual(validateAgentHint({}), ['session is required and must be an object']);
  assert.deepEqual(validateAgentHint({ session: {} }), ['session.session_id must be a non-empty string']);
  assert.match(validateAgentHint({ session: { session_id: 's', call_index: 0 } })[0], /call_index must be an integer >= 1/);
  assert.match(validateAgentHint({ session: { session_id: 's', epoch: -1 } })[0], /epoch must be an integer >= 0/);
  assert.match(
    validateAgentHint({ session: { session_id: 's', derivation: { relation: 'clone' } } })[0],
    /relation must be fork/,
  );
});

test('Pi-unsupported derivation values are refused', () => {
  assert.deepEqual(validateAgentHint({
    session: { session_id: 's', derivation: { relation: 'spawn', join: 'async' } },
  }), [
    'session.derivation.relation must be fork',
    'session.derivation.join is unsupported by Pi',
  ]);
  assert.deepEqual(validateAgentHint({
    session: { session_id: 's', derivation: { relation: 'fork', join: 'sync' } },
  }), ['session.derivation.join is unsupported by Pi']);
  assert.deepEqual(validateAgentHint({
    session: { session_id: 's', derivation: { relation: 'handoff' } },
  }), ['session.derivation.relation must be fork']);
});

test('agent_status rejects states outside the AgentHint vocabulary', () => {
  // `idle` is the host's own status and deliberately not part of this protocol: the document is
  // explicit that its states are not the host's, and accepting `idle` here would let the two
  // vocabularies merge by accident.
  assert.deepEqual(
    validateAgentHint({ session: { session_id: 's' }, agent_status: { state: 'idle' } }),
    ['agent_status.state is not a known value'],
  );
  assert.deepEqual(
    validateAgentHint({ session: { session_id: 's' }, agent_status: { state: 'tool', tools: [] } }),
    ['agent_status.tools must be a non-empty array when present'],
  );
});

test('priority levels must be numbers and reasons non-empty strings', () => {
  assert.deepEqual(
    validateAgentHint({ session: { session_id: 's' }, priority: { level: 'high' } }),
    ['priority.level must be a number'],
  );
  assert.deepEqual(
    validateAgentHint({ session: { session_id: 's' }, strict_priority: { level: 3, reason: '' } }),
    ['strict_priority.reason must be a non-empty string'],
  );
});

test('cache_control accepts one entry or an array, and refuses an inverted range', () => {
  assert.deepEqual(validateAgentHint({ session: { session_id: 's' }, cache_control: { type: 'pin' } }), []);
  assert.deepEqual(validateAgentHint({ session: { session_id: 's' }, cache_control: [] }), [
    'cache_control must not be an empty array',
  ]);
  const inverted = validateAgentHint({
    session: { session_id: 's' },
    cache_control: { type: 'ephemeral', ttl_s: 12, range: { start: 5, end: 2 } },
  });
  assert.deepEqual(inverted, ['cache_control.range.end must be >= range.start']);
});

test('prediction rejects a probability outside 0..1', () => {
  assert.deepEqual(
    validateAgentHint({ session: { session_id: 's' }, prediction: { next_action: { state: 'tool', prob: 1.4 } } }),
    ['prediction.next_action.prob must be within 0..1'],
  );
  assert.deepEqual(
    validateAgentHint({ session: { session_id: 's' }, prediction: { output_tokens: -5 } }),
    ['prediction.output_tokens must be a non-negative number'],
  );
});

test('tool identifiers and predicted durations are type checked', () => {
  assert.deepEqual(
    validateAgentHint({ session: { session_id: 's' }, agent_status: { state: 'tool', tools: [{ name: 'task', call_id: 1 }] } }),
    ['agent_status.tools[0].call_id must be a non-empty string'],
  );
  assert.deepEqual(
    validateAgentHint({
      session: { session_id: 's' },
      prediction: { next_action: { state: 'tool', tools: [{ name: 'search', expected_duration_s: -1 }] } },
    }),
    ['prediction.next_action.tools[0].expected_duration_s must be a non-negative number'],
  );
});

test('an unknown top-level member is refused rather than silently dropped', () => {
  const violations = validateAgentHint({ session: { session_id: 's' }, hint_version: 2 });
  assert.deepEqual(violations, ['unknown member "hint_version"']);
});

test('dropUndefined removes absent optional fields without touching falsy ones', () => {
  assert.deepEqual(dropUndefined({ a: 1, b: undefined, c: 0, d: false, e: '' }), { a: 1, c: 0, d: false, e: '' });
});

test('the budget ladder drops whole optional groups and never the session', () => {
  const hint = valid();
  const sizeOf = (value) => JSON.stringify(value).length;
  // A budget only the session block can satisfy: everything optional is shed, in the documented
  // order, and the result stays a valid hint.
  const fitted = fitToBudget(hint, sizeOf, sizeOf({ session: hint.session }));
  assert.notEqual(fitted, undefined);
  assert.deepEqual(fitted.dropped, ['prediction', 'priority', 'cache_control', 'agent_status']);
  assert.deepEqual(fitted.hint, { session: hint.session });
  assert.deepEqual(validateAgentHint(fitted.hint), []);
});

test('the budget ladder reports failure instead of inventing a smaller hint', () => {
  const hint = valid();
  const fitted = fitToBudget(hint, (value) => JSON.stringify(value).length, 1);
  assert.equal(fitted, undefined, 'a hint that cannot fit is not sent, rather than corrupted');
});

test('a hint inside the budget is returned untouched', () => {
  const hint = valid();
  const fitted = fitToBudget(hint, (value) => JSON.stringify(value).length, MAX_HINT_BYTES);
  assert.deepEqual(fitted, { hint, dropped: [] });
});

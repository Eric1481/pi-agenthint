import { readFileSync } from 'node:fs';

/** Error raised for a precise invalid configuration path. */
export class ConfigError extends Error {
  constructor(path, message) {
    super(`${path || 'config'}: ${message}`);
    this.name = 'ConfigError';
    this.path = path;
  }
}

export const DEFAULT_AGENT_TYPE = 'pi-agent';

/** Installing the dedicated package is the opt-in; external reporting remains off. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  agentType: DEFAULT_AGENT_TYPE,
  suspendAfterMs: 90000,
  humanApprovalWaitMs: 300000,
  humanInputWaitMs: 60000,
  cacheControl: true,
  /** null = derive the retention window from runtime signals; a number pins it explicitly. */
  cacheTtlS: null,
  priority: true,
  prediction: true,
  predictionWindow: 20,
  predictionPolicy: 'p90',
  predictionMinSamples: 3,
  strictPriority: true,
  strictPriorityEnv: 'PI_AGENTHINT_STRICT_PRIORITY',
  /** null = no parent; {relation, parent_session_id, join?, fork_point?} otherwise. */
  lineage: null,
  reporting: Object.freeze({
    enabled: false,
    endpoint: '',
    tokenEnv: 'PI_AGENTHINT_TOKEN',
    timeoutMs: 3000,
    maxRetries: 2,
    queueLimit: 64,
  }),
});

/**
 * Lineage this deployment declares for the session it starts.
 *
 * Pi can observe a fork on its own, but it has no subagent mechanism: a `spawn` is only
 * truthful when whatever started this process says so. The value is passed through verbatim
 * (snake_case, as it appears on the wire) so the builder does not have to translate twice.
 */
function parsedLineage(value) {
  if (value === undefined || value === null) return null;
  const detail = object(value, 'lineage');
  rejectUnknown(detail, ['relation', 'parent_session_id', 'join', 'fork_point'], 'lineage');
  const relation = ['fork', 'spawn'].includes(detail.relation) ? detail.relation : undefined;
  if (relation === undefined) throw new ConfigError('lineage.relation', 'expected fork or spawn');
  const parent = detail.parent_session_id;
  if (typeof parent !== 'string' || parent === '') {
    throw new ConfigError('lineage.parent_session_id', 'expected a non-empty string');
  }
  const line = { relation, parent_session_id: parent };
  if (relation === 'spawn') {
    if (detail.join !== undefined && !['sync', 'async'].includes(detail.join)) {
      throw new ConfigError('lineage.join', 'expected sync or async');
    }
    line.join = detail.join ?? 'sync';
  } else if (detail.fork_point !== undefined) {
    if (!Number.isSafeInteger(detail.fork_point) || detail.fork_point < 0) {
      throw new ConfigError('lineage.fork_point', 'expected a non-negative integer');
    }
    line.fork_point = detail.fork_point;
  }
  return Object.freeze(line);
}

function object(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(path, 'expected an object');
  }
  return value;
}

function rejectUnknown(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ConfigError(path ? `${path}.${key}` : key, 'unknown field');
  }
}

function boolean(value, path, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ConfigError(path, 'expected a boolean');
  return value;
}

function string(value, path, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(path, 'expected a non-empty string');
  return value;
}

function integer(value, path, fallback, minimum = 0) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ConfigError(path, `expected an integer >= ${minimum}`);
  }
  return value;
}

/**
 * An integer that may also be `null`, used where `null` carries a distinct meaning from `0`
 * (absent = derive, 0 = disabled, positive = fixed value).
 */
function nullableInteger(value, path, fallback, minimum = 0) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ConfigError(path, `expected null or an integer >= ${minimum}`);
  }
  return value;
}

function envName(value, path, fallback) {
  const result = string(value, path, fallback);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) throw new ConfigError(path, 'expected an environment variable name');
  return result;
}

function endpoint(value, path, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new ConfigError(path, 'expected a string');
  if (value === '') return '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(path, 'expected an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new ConfigError(path, 'expected an absolute http(s) URL');
  return parsed.href;
}

/** Parse one complete configuration. Unknown fields and implicit coercions are rejected. */
export function parseConfig(value = {}) {
  const root = object(value, 'config');
  const allowed = [
    'enabled', 'agentType', 'suspendAfterMs', 'humanApprovalWaitMs', 'humanInputWaitMs',
    'cacheControl', 'cacheTtlS', 'priority', 'prediction', 'predictionWindow',
    'predictionPolicy', 'predictionMinSamples', 'strictPriority', 'strictPriorityEnv', 'reporting',
    'lineage',
  ];
  rejectUnknown(root, allowed, '');
  const reporting = object(root.reporting ?? {}, 'reporting');
  rejectUnknown(reporting, ['enabled', 'endpoint', 'tokenEnv', 'timeoutMs', 'maxRetries', 'queueLimit'], 'reporting');
  const policy = root.predictionPolicy ?? DEFAULT_CONFIG.predictionPolicy;
  if (!['mean', 'p90', 'max'].includes(policy)) {
    throw new ConfigError('predictionPolicy', 'expected mean, p90, or max');
  }
  const resolvedReporting = {
    enabled: boolean(reporting.enabled, 'reporting.enabled', DEFAULT_CONFIG.reporting.enabled),
    endpoint: endpoint(reporting.endpoint, 'reporting.endpoint', DEFAULT_CONFIG.reporting.endpoint),
    tokenEnv: envName(reporting.tokenEnv, 'reporting.tokenEnv', DEFAULT_CONFIG.reporting.tokenEnv),
    timeoutMs: integer(reporting.timeoutMs, 'reporting.timeoutMs', DEFAULT_CONFIG.reporting.timeoutMs, 1),
    maxRetries: integer(reporting.maxRetries, 'reporting.maxRetries', DEFAULT_CONFIG.reporting.maxRetries),
    queueLimit: integer(reporting.queueLimit, 'reporting.queueLimit', DEFAULT_CONFIG.reporting.queueLimit, 1),
  };
  if (resolvedReporting.enabled && resolvedReporting.endpoint === '') {
    throw new ConfigError('reporting.endpoint', 'required when reporting is enabled');
  }
  return {
    enabled: boolean(root.enabled, 'enabled', DEFAULT_CONFIG.enabled),
    agentType: string(root.agentType, 'agentType', DEFAULT_CONFIG.agentType),
    suspendAfterMs: integer(root.suspendAfterMs, 'suspendAfterMs', DEFAULT_CONFIG.suspendAfterMs),
    humanApprovalWaitMs: integer(root.humanApprovalWaitMs, 'humanApprovalWaitMs', DEFAULT_CONFIG.humanApprovalWaitMs),
    humanInputWaitMs: integer(root.humanInputWaitMs, 'humanInputWaitMs', DEFAULT_CONFIG.humanInputWaitMs),
    cacheControl: boolean(root.cacheControl, 'cacheControl', DEFAULT_CONFIG.cacheControl),
    cacheTtlS: nullableInteger(root.cacheTtlS, 'cacheTtlS', DEFAULT_CONFIG.cacheTtlS),
    priority: boolean(root.priority, 'priority', DEFAULT_CONFIG.priority),
    prediction: boolean(root.prediction, 'prediction', DEFAULT_CONFIG.prediction),
    predictionWindow: integer(root.predictionWindow, 'predictionWindow', DEFAULT_CONFIG.predictionWindow, 1),
    predictionPolicy: policy,
    predictionMinSamples: integer(root.predictionMinSamples, 'predictionMinSamples', DEFAULT_CONFIG.predictionMinSamples, 1),
    strictPriority: boolean(root.strictPriority, 'strictPriority', DEFAULT_CONFIG.strictPriority),
    strictPriorityEnv: envName(root.strictPriorityEnv, 'strictPriorityEnv', DEFAULT_CONFIG.strictPriorityEnv),
    lineage: parsedLineage(root.lineage),
    reporting: resolvedReporting,
  };
}

/** Resolve the sole external config source. Invalid explicit config fails closed. */
export function resolveConfig(options = {}) {
  const env = options.env ?? process.env;
  const path = env.PI_AGENTHINT_CONFIG;
  if (path === undefined || path === '') return { config: parseConfig({}), source: 'defaults' };
  try {
    const text = (options.readFile ?? ((file) => readFileSync(file, 'utf8')))(path);
    return { config: parseConfig(JSON.parse(text)), source: path };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { config: { ...parseConfig({}), enabled: false }, source: path, error: message };
  }
}

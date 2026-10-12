/** Durable Agent Hint facts in Pi's non-context custom session entries. */

export const HINT_CHECKPOINT_TYPE = 'pi-agenthint.checkpoint';
const LEGACY_CHECKPOINT_TYPES = new Set([
  HINT_CHECKPOINT_TYPE, 'ascendagent-pi.agent-hint-checkpoint',
]);
const CHECKPOINT_VERSION = 1;

/**
 * @typedef {{ sessionId: string, callIndex: number, epoch: number,
 *   parentSessionId?: string, forkPoint?: number }} HintCheckpoint
 */

/**
 * @param {unknown} value
 * @param {string} sessionId
 * @returns {HintCheckpoint | undefined}
 */
function parseCheckpoint(value, sessionId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = /** @type {Record<string, unknown>} */ (value);
  if (data.version !== CHECKPOINT_VERSION || data.sessionId !== sessionId
    || !Number.isSafeInteger(data.callIndex) || data.callIndex < 0
    || !Number.isSafeInteger(data.epoch) || data.epoch < 0) return undefined;
  if (data.parentSessionId !== undefined
    && (typeof data.parentSessionId !== 'string' || data.parentSessionId === ''
      || data.parentSessionId === sessionId)) return undefined;
  if (data.forkPoint !== undefined
    && (data.parentSessionId === undefined || !Number.isSafeInteger(data.forkPoint)
      || data.forkPoint < 0)) return undefined;
  return {
    sessionId,
    callIndex: /** @type {number} */ (data.callIndex),
    epoch: /** @type {number} */ (data.epoch),
    ...(data.parentSessionId === undefined ? {} : { parentSessionId: /** @type {string} */ (data.parentSessionId) }),
    ...(data.forkPoint === undefined ? {} : { forkPoint: /** @type {number} */ (data.forkPoint) }),
  };
}

/**
 * Recover the last valid checkpoint for this session, including abandoned branches.
 * Pi's entries are append-only; request ordinals and epoch are session-wide, not branch-local.
 * @param {{ getEntries?: () => unknown[] } | undefined} manager
 * @param {string | undefined} sessionId
 * @returns {HintCheckpoint | undefined}
 */
export function readHintCheckpoint(manager, sessionId) {
  if (sessionId === undefined || typeof manager?.getEntries !== 'function') return undefined;
  try {
    const entries = manager.getEntries();
    if (!Array.isArray(entries)) return undefined;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type !== 'custom' || !LEGACY_CHECKPOINT_TYPES.has(entry.customType)) continue;
      const checkpoint = parseCheckpoint(entry.data, sessionId);
      if (checkpoint !== undefined) return checkpoint;
    }
  } catch {
    // Recovery is advisory: a damaged session must not prevent Pi from starting.
  }
  return undefined;
}

/**
 * Append a checkpoint without entering LLM context. Pi persists it with the session file.
 * @param {{ appendEntry?: (type: string, data: unknown) => void } | undefined} pi
 * @param {string | undefined} sessionId
 * @param {{ callIndex: number, epoch: number, parentSessionId?: string, forkPoint?: number }} state
 * @returns {boolean} whether Pi accepted the entry.
 */
export function writeHintCheckpoint(pi, sessionId, state) {
  if (sessionId === undefined || typeof pi?.appendEntry !== 'function') return false;
  const data = parseCheckpoint({ version: CHECKPOINT_VERSION, sessionId, ...state }, sessionId);
  if (data === undefined) return false;
  try {
    pi.appendEntry(HINT_CHECKPOINT_TYPE, { version: CHECKPOINT_VERSION, ...data });
    return true;
  } catch {
    // The hint must never block its host request because persistence failed.
    return false;
  }
}

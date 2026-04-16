'use strict';

const path = require('path');

/**
 * Compute read/edit/write stats for the last N tool calls (sliding window).
 */
function computeSlidingWindow(events, windowSize) {
  const window = events.slice(-windowSize);
  let reads = 0, edits = 0, writes = 0;
  for (const evt of window) {
    if (evt.category === 'read') reads++;
    else if (evt.category === 'edit') edits++;
    else if (evt.category === 'write') writes++;
  }
  const totalMods = edits + writes;
  const ratio = totalMods === 0 ? null : reads / totalMods;
  return { reads, edits, writes, ratio, total: window.length };
}

/**
 * Detect edits/writes that had no prior read of the same file.
 * A read "covers" a file if the read path equals or is a parent of the edit path.
 */
function computeBlindEdits(events, lookbackDistance) {
  let blindEditCount = 0;
  const blindEditFiles = [];

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (evt.category !== 'edit' && evt.category !== 'write') continue;
    if (!evt.filePath) continue;

    const editPath = path.resolve(evt.filePath);
    let covered = false;

    const start = Math.max(0, i - lookbackDistance);
    for (let j = start; j < i; j++) {
      const prev = events[j];
      if (prev.category !== 'read') continue;
      if (!prev.filePath) continue;

      const readPath = path.resolve(prev.filePath);
      // Exact match or readPath is parent directory (Glob/Grep)
      if (editPath === readPath || editPath.startsWith(readPath + path.sep)) {
        covered = true;
        break;
      }
    }

    if (!covered) {
      blindEditCount++;
      if (!blindEditFiles.includes(evt.filePath)) {
        blindEditFiles.push(evt.filePath);
      }
    }
  }

  return { blindEditCount, blindEditFiles };
}

/**
 * Detect files edited 3+ times in the last N tool calls (thrashing).
 */
function computeThrashing(events, windowSize, threshold) {
  const window = events.slice(-windowSize);
  const fileCounts = {};

  for (const evt of window) {
    if (evt.category !== 'edit' && evt.category !== 'write') continue;
    if (!evt.filePath) continue;
    fileCounts[evt.filePath] = (fileCounts[evt.filePath] || 0) + 1;
  }

  const thrashingFiles = [];
  let maxEditsOnOneFile = 0;

  for (const [file, count] of Object.entries(fileCounts)) {
    if (count > maxEditsOnOneFile) maxEditsOnOneFile = count;
    if (count >= threshold) thrashingFiles.push(file);
  }

  return { thrashingFiles, maxEditsOnOneFile };
}

/**
 * Compute a composite quality score (0-100).
 *
 * @param {object} params
 * @param {object} params.slidingWindow  - from computeSlidingWindow
 * @param {object} params.blindEdits     - from computeBlindEdits
 * @param {object} params.thrashing      - from computeThrashing
 * @param {number|null} params.contextPct - context window usage (0-100)
 * @param {object} params.config         - user config
 * @returns {number} 0-100 where 100 = perfect
 */
function computeCompositeScore({ slidingWindow, blindEdits, thrashing, contextPct, config }) {
  // Base score from ratio (0-100)
  const ratio = slidingWindow.ratio;
  const baseScore = ratio === null
    ? 100
    : Math.min(ratio / config.minReadToEditRatio, 1.0) * 100;

  // Write penalty: high Write% means Claude can't do surgical edits
  const totalMods = slidingWindow.edits + slidingWindow.writes;
  const writePct = totalMods === 0 ? 0 : slidingWindow.writes / totalMods;
  const writePenalty = writePct * 15;

  // Blind edit penalty: edits without prior read
  const blindPenalty = Math.min(blindEdits.blindEditCount * 5, 20);

  // Thrashing penalty: same file edited repeatedly
  const thrashPenalty = Math.min(thrashing.thrashingFiles.length * 8, 20);

  // Context pressure: quality degrades as context fills up
  const ctxPct = contextPct != null ? contextPct : 0;
  const contextMultiplier = ctxPct <= 50 ? 1.0 : 1.0 - (ctxPct - 50) * 0.006;

  const score = (baseScore - writePenalty - blindPenalty - thrashPenalty) * contextMultiplier;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Run full analysis on a parsed session.
 *
 * @param {object} detailed - from parseSessionDetailed()
 * @param {number|null} contextPct
 * @param {object} config
 * @returns {object} full analysis result
 */
function analyse(detailed, contextPct, config) {
  const slidingWindow = computeSlidingWindow(detailed.events, config.slidingWindowSize);
  const blindEdits = computeBlindEdits(detailed.events, config.blindEditLookback);
  const thrashing = computeThrashing(detailed.events, config.slidingWindowSize, config.thrashingThreshold);
  const compositeScore = computeCompositeScore({ slidingWindow, blindEdits, thrashing, contextPct, config });

  return {
    reads: detailed.reads,
    edits: detailed.edits,
    writes: detailed.writes,
    totalToolCalls: detailed.totalToolCalls,
    slidingWindow,
    blindEdits,
    thrashing,
    compositeScore,
  };
}

module.exports = {
  computeSlidingWindow,
  computeBlindEdits,
  computeThrashing,
  computeCompositeScore,
  analyse,
};

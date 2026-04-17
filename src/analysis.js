'use strict';

const path = require('path');

// ── EMA helpers ──────────────────────────────────────────────────────────────

/**
 * Exponential Moving Average update.
 * alpha = 2/(N+1) where N is the equivalent window size.
 */
function emaUpdate(prev, observation, alpha) {
  if (prev === null || prev === undefined) return observation;
  return alpha * observation + (1 - alpha) * prev;
}

// Default alpha ≈ 0.06 → effective memory of ~33 events
const DEFAULT_EMA_ALPHA = 0.06;

// Alpha for smoothing the final composite score between invocations
const SCORE_SMOOTH_ALPHA = 0.15;

// ── Sigmoid context multiplier ───────────────────────────────────────────────

/**
 * Sigmoid-based context pressure multiplier.
 * Fine at <40%, gradual drop 40-65%, steep drop after 65%.
 * Returns ~1.0 at 40%, ~0.82 at 60%, ~0.55 at 70%, ~0.32 at 80%.
 */
function contextMultiplier(ctxPct) {
  if (ctxPct == null || ctxPct <= 40) return 1.0;
  const k = 0.12;
  const midpoint = 65;
  const raw = 1.0 / (1.0 + Math.exp(k * (ctxPct - midpoint)));
  const atBaseline = 1.0 / (1.0 + Math.exp(k * (40 - midpoint)));
  return 0.15 + 0.85 * (raw / atBaseline);
}

// ── Sliding window ───────────────────────────────────────────────────────────

function computeSlidingWindow(events, windowSize) {
  const window = events.slice(-windowSize);
  let reads = 0, edits = 0, writes = 0, newFileWrites = 0;
  for (const evt of window) {
    if (evt.category === 'read') reads++;
    else if (evt.category === 'edit') edits++;
    else if (evt.category === 'write') {
      writes++;
      // A write to a file never read in the session = new file creation, not a rewrite.
      // Exclude it from the writePenalty so legitimate scaffolding doesn't tank the score.
      if (evt.filePath) {
        const writePath = path.resolve(evt.filePath);
        const everRead = events.some(e =>
          e.category === 'read' && e.filePath &&
          path.resolve(e.filePath) === writePath
        );
        if (!everRead) newFileWrites++;
      } else {
        newFileWrites++;
      }
    }
  }
  const totalMods = edits + writes;
  const ratio = totalMods === 0 ? null : reads / totalMods;
  return { reads, edits, writes, newFileWrites, ratio, total: window.length };
}

// ── EMA ratio ────────────────────────────────────────────────────────────────

/**
 * Compute EMA-smoothed read fraction from events.
 * Each tool call is: 1 if read, 0 if edit/write, ignored if other.
 * Returns the EMA value (0-1) or null if no relevant events.
 */
function computeEmaRatio(events, prevEma, alpha) {
  let ema = prevEma;
  let hasData = false;

  for (const evt of events) {
    if (evt.category === 'read') {
      ema = emaUpdate(ema, 1.0, alpha);
      hasData = true;
    } else if (evt.category === 'edit' || evt.category === 'write') {
      ema = emaUpdate(ema, 0.0, alpha);
      hasData = true;
    }
  }

  return hasData ? ema : null;
}

// ── Blind edits (windowed) ───────────────────────────────────────────────────

/**
 * Detect edits/writes without prior read — only within the recent window.
 * Write to a file never read in the session = new file creation, not penalized.
 */
function computeBlindEdits(events, windowSize, lookbackDistance) {
  const window = events.slice(-windowSize);

  let blindEditCount = 0;
  const blindEditFiles = [];

  for (let i = 0; i < window.length; i++) {
    const evt = window[i];
    if (evt.category !== 'edit' && evt.category !== 'write') continue;
    if (!evt.filePath) continue;

    // Write to a file never read in the entire session = new file, skip
    if (evt.category === 'write') {
      const editPath = path.resolve(evt.filePath);
      const everRead = events.some(e =>
        e.category === 'read' && e.filePath &&
        path.resolve(e.filePath) === editPath
      );
      if (!everRead) continue;
    }

    const editPath = path.resolve(evt.filePath);
    let covered = false;

    const start = Math.max(0, i - lookbackDistance);
    for (let j = start; j < i; j++) {
      const prev = window[j];
      if (prev.category !== 'read') continue;
      if (!prev.filePath) continue;

      const readPath = path.resolve(prev.filePath);
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

// ── Thrashing ────────────────────────────────────────────────────────────────

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

// ── Bash failure detection ───────────────────────────────────────────────────

/**
 * Detect consecutive Bash failures (same command failing 3+ times).
 */
function computeBashFailures(events, windowSize) {
  const window = events.slice(-windowSize);
  let consecutiveFailures = 0;
  let maxConsecutive = 0;

  for (const evt of window) {
    if (evt.name === 'Bash') {
      if (evt.exitCode != null && evt.exitCode !== 0) {
        consecutiveFailures++;
        if (consecutiveFailures > maxConsecutive) maxConsecutive = consecutiveFailures;
      } else {
        consecutiveFailures = 0;
      }
    }
  }

  return { maxConsecutive };
}

// ── Composite score ──────────────────────────────────────────────────────────

/**
 * Compute composite quality score (0-100).
 *
 * @param {object} params
 * @param {number|null} params.emaRatio       - EMA-smoothed read fraction (0-1)
 * @param {object}      params.slidingWindow  - from computeSlidingWindow
 * @param {object}      params.blindEdits     - from computeBlindEdits
 * @param {object}      params.thrashing      - from computeThrashing
 * @param {object}      params.bashFailures   - from computeBashFailures
 * @param {number|null} params.contextPct     - context window usage (0-100)
 * @param {object}      params.config
 * @param {number|null} params.prevScore      - previous smoothed score (from cache)
 */
function computeCompositeScore({ emaRatio, slidingWindow, blindEdits, thrashing, bashFailures, contextPct, config, prevScore }) {
  // Base score from EMA ratio
  // emaRatio is 0-1 (fraction of reads). Convert to read:edit ratio equivalent.
  // emaRatio 0.8 means 80% reads → ratio = 0.8/0.2 = 4.0
  let baseScore;
  if (emaRatio === null) {
    baseScore = 100;
  } else {
    const emaAsRatio = emaRatio >= 1 ? 999 : emaRatio / (1 - emaRatio);
    baseScore = Math.min(emaAsRatio / config.minReadToEditRatio, 1.0) * 100;
  }

  // Write penalty — only count writes that rewrite existing files.
  // Creating brand-new files is legitimate scaffolding, not a "full rewrite" signal.
  const totalMods = slidingWindow.edits + slidingWindow.writes;
  const rewriteCount = slidingWindow.writes - (slidingWindow.newFileWrites || 0);
  const writePct = totalMods === 0 ? 0 : rewriteCount / totalMods;
  const writePenalty = writePct * 15;

  // Blind edit penalty
  const blindPenalty = Math.min(blindEdits.blindEditCount * 5, 20);

  // Thrashing penalty
  const thrashPenalty = Math.min(thrashing.thrashingFiles.length * 8, 20);

  // Bash failure penalty
  const bashPenalty = bashFailures.maxConsecutive >= 3 ? Math.min((bashFailures.maxConsecutive - 2) * 5, 15) : 0;

  // Sigmoid context multiplier
  const ctxMult = contextMultiplier(contextPct);

  const rawScore = (baseScore - writePenalty - blindPenalty - thrashPenalty - bashPenalty) * ctxMult;
  const clamped = Math.max(0, Math.min(100, Math.round(rawScore)));

  // Smooth final score with EMA to prevent jumps between invocations
  if (prevScore === null || prevScore === undefined) return clamped;
  return Math.max(0, Math.min(100, Math.round(SCORE_SMOOTH_ALPHA * clamped + (1 - SCORE_SMOOTH_ALPHA) * prevScore)));
}

// ── Main analyse function ────────────────────────────────────────────────────

/**
 * Run full analysis on a parsed session.
 *
 * @param {object}      detailed    - from parseSessionDetailed()
 * @param {number|null} contextPct
 * @param {object}      config
 * @param {object|null} cache       - previous analysis state { emaRatio, prevScore, prevContextPct }
 * @returns {object} full analysis result including updated cache values
 */
function analyse(detailed, contextPct, config, cache) {
  cache = cache || {};

  // Detect autocompact: context % dropped >30% → reset EMA
  let prevEma = cache.emaRatio != null ? cache.emaRatio : null;
  let prevScore = cache.prevScore != null ? cache.prevScore : null;

  if (cache.prevContextPct != null && contextPct != null) {
    if (cache.prevContextPct - contextPct > 30) {
      // Autocompact (or manual /compact) detected. A large context drop means Claude
      // just got a fresh runway — the session is effectively healthier, not worse.
      // Reset the EMA so stale read/edit history doesn't bias the ratio, and floor
      // the smoothed score at 75 so the user visibly sees the recovery instead of
      // dropping to the raw value (which still carries penalties from pre-compact
      // events still in the sliding window).
      prevEma = null;
      prevScore = Math.max(prevScore != null ? prevScore : 0, 75);
    }
  }

  const slidingWindow = computeSlidingWindow(detailed.events, config.slidingWindowSize);
  const emaRatio = computeEmaRatio(detailed.events, prevEma, DEFAULT_EMA_ALPHA);
  const blindEdits = computeBlindEdits(detailed.events, config.slidingWindowSize, config.blindEditLookback);
  const thrashing = computeThrashing(detailed.events, config.slidingWindowSize, config.thrashingThreshold);
  const bashFailures = computeBashFailures(detailed.events, config.slidingWindowSize);
  const compositeScore = computeCompositeScore({
    emaRatio, slidingWindow, blindEdits, thrashing, bashFailures, contextPct, config, prevScore,
  });

  return {
    reads: detailed.reads,
    edits: detailed.edits,
    writes: detailed.writes,
    totalToolCalls: detailed.totalToolCalls,
    slidingWindow,
    emaRatio,
    blindEdits,
    thrashing,
    bashFailures,
    compositeScore,
    // Cache values to persist for next invocation
    _cache: {
      emaRatio,
      prevScore: compositeScore,
      prevContextPct: contextPct,
    },
  };
}

module.exports = {
  computeSlidingWindow,
  computeEmaRatio,
  computeBlindEdits,
  computeThrashing,
  computeBashFailures,
  computeCompositeScore,
  contextMultiplier,
  analyse,
};

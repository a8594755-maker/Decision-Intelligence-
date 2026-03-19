/**
 * patch-applier.js — Parse and apply unified diffs from LLM output
 *
 * Supports standard unified diff format:
 *   --- a/path/to/file
 *   +++ b/path/to/file
 *   @@ -start,count +start,count @@
 *   context / additions / removals
 */

import fs from 'fs';
import path from 'path';

// ── Parse unified diff ──────────────────────────────────────────────────────

/**
 * @typedef {object} Hunk
 * @property {number} oldStart
 * @property {number} oldCount
 * @property {number} newStart
 * @property {number} newCount
 * @property {string[]} lines - raw diff lines (prefixed with ' ', '+', '-')
 */

/**
 * @typedef {object} FilePatch
 * @property {string} oldPath
 * @property {string} newPath
 * @property {Hunk[]} hunks
 */

/**
 * Parse a unified diff string into structured patches.
 * @param {string} diffString
 * @returns {FilePatch[]}
 */
export function parseDiff(diffString) {
  const patches = [];
  const lines = diffString.split('\n');
  let i = 0;

  while (i < lines.length) {
    // Find --- a/... header
    if (!lines[i].startsWith('--- ')) { i++; continue; }

    const oldPath = lines[i].replace(/^---\s+[ab]\//, '').trim();
    i++;

    if (i >= lines.length || !lines[i].startsWith('+++ ')) {
      continue;
    }
    const newPath = lines[i].replace(/^\+\+\+\s+[ab]\//, '').trim();
    i++;

    const hunks = [];

    // Parse hunks
    while (i < lines.length && lines[i].startsWith('@@')) {
      const hunkHeader = lines[i].match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!hunkHeader) { i++; break; }

      const hunk = {
        oldStart: parseInt(hunkHeader[1], 10),
        oldCount: hunkHeader[2] != null ? parseInt(hunkHeader[2], 10) : 1,
        newStart: parseInt(hunkHeader[3], 10),
        newCount: hunkHeader[4] != null ? parseInt(hunkHeader[4], 10) : 1,
        lines: [],
      };
      i++;

      // Collect hunk lines
      while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('+++ ')) break;
        if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) {
          hunk.lines.push(line);
          i++;
        } else if (line === '') {
          // Could be context line with empty content
          hunk.lines.push(' ');
          i++;
        } else {
          break;
        }
      }

      hunks.push(hunk);
    }

    if (hunks.length > 0) {
      patches.push({ oldPath, newPath, hunks });
    }
  }

  return patches;
}

// ── Apply patches ───────────────────────────────────────────────────────────

/**
 * Apply a single hunk to an array of file lines.
 * Returns the modified lines array or null if the hunk doesn't match.
 */
function applyHunk(fileLines, hunk) {
  // Find the hunk's target location (0-indexed)
  const targetLine = hunk.oldStart - 1;

  // Extract expected old lines from hunk
  const oldLines = hunk.lines
    .filter(l => l.startsWith(' ') || l.startsWith('-'))
    .map(l => l.slice(1));

  // Fuzzy search: try exact position first, then ±5 lines
  let bestOffset = null;
  for (let offset = 0; offset <= 10; offset++) {
    for (const dir of [0, 1, -1]) {
      const tryLine = targetLine + (offset * dir);
      if (tryLine < 0 || tryLine + oldLines.length > fileLines.length) continue;

      const match = oldLines.every((expected, j) =>
        fileLines[tryLine + j].trimEnd() === expected.trimEnd()
      );
      if (match) {
        bestOffset = tryLine;
        break;
      }
    }
    if (bestOffset !== null) break;
  }

  if (bestOffset === null) return null;

  // Build replacement lines
  const newLines = [];
  for (const line of hunk.lines) {
    if (line.startsWith('+')) {
      newLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      newLines.push(line.slice(1));
    }
    // '-' lines are removed (not added to newLines)
  }

  // Splice
  const result = [...fileLines];
  result.splice(bestOffset, oldLines.length, ...newLines);
  return result;
}

/**
 * Apply a unified diff string to the filesystem.
 *
 * @param {string} diffString - unified diff output from LLM
 * @param {object} [opts]
 * @param {string} [opts.projectRoot] - project root for resolving relative paths
 * @param {boolean} [opts.dryRun=false] - if true, don't write files
 * @returns {{ applied: string[], failed: string[], diffs: Array<{file: string, before: string, after: string}> }}
 */
export function applyDiff(diffString, opts = {}) {
  const { projectRoot = process.cwd(), dryRun = false } = opts;
  const patches = parseDiff(diffString);

  const applied = [];
  const failed = [];
  const diffs = [];

  for (const patch of patches) {
    const filePath = path.isAbsolute(patch.newPath)
      ? patch.newPath
      : path.join(projectRoot, patch.newPath);

    if (!fs.existsSync(filePath)) {
      failed.push(`${patch.newPath} (file not found)`);
      continue;
    }

    // Protected paths
    const rel = path.relative(projectRoot, filePath);
    if (rel.startsWith('node_modules') || rel.startsWith('.env') || rel.includes('supabase/migrations')) {
      failed.push(`${patch.newPath} (protected path)`);
      continue;
    }

    const original = fs.readFileSync(filePath, 'utf8');
    let fileLines = original.split('\n');
    let allHunksOk = true;

    for (const hunk of patch.hunks) {
      const result = applyHunk(fileLines, hunk);
      if (result === null) {
        allHunksOk = false;
        break;
      }
      fileLines = result;
    }

    if (!allHunksOk) {
      failed.push(`${patch.newPath} (hunk mismatch)`);
      continue;
    }

    const after = fileLines.join('\n');
    diffs.push({ file: patch.newPath, before: original, after });

    if (!dryRun) {
      fs.writeFileSync(filePath, after, 'utf8');
    }
    applied.push(patch.newPath);
  }

  return { applied, failed, diffs };
}

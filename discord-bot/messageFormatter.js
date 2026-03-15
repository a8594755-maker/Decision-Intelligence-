const DISCORD_MAX_LENGTH = 1990; // Leave some margin from 2000

/**
 * Convert markdown tables to Discord-friendly format.
 * Discord doesn't render markdown tables, so convert to code blocks.
 */
function convertTables(text) {
  // Match markdown table blocks (header + separator + rows)
  const tableRegex = /(?:^|\n)(\|.+\|)\n(\|[-:| ]+\|)\n((?:\|.+\|\n?)+)/g;

  return text.replace(tableRegex, (match, header, separator, body) => {
    const parseRow = (row) =>
      row.split('|').slice(1, -1).map(c => c.trim());

    const headers = parseRow(header);
    const rows = body.trim().split('\n').map(parseRow);

    // Calculate column widths
    const widths = headers.map((h, i) => {
      const colValues = [h, ...rows.map(r => r[i] || '')];
      return Math.min(Math.max(...colValues.map(v => v.length)), 40);
    });

    // Build formatted table
    const pad = (str, w) => (str || '').slice(0, w).padEnd(w);
    const line = widths.map(w => '─'.repeat(w)).join('─┼─');

    const headerLine = headers.map((h, i) => pad(h, widths[i])).join(' │ ');
    const dataLines = rows.map(r =>
      r.map((c, i) => pad(c, widths[i])).join(' │ ')
    );

    return '\n```\n' + headerLine + '\n' + line + '\n' + dataLines.join('\n') + '\n```\n';
  });
}

/**
 * Split a long message into Discord-safe chunks (≤2000 chars each).
 * Avoids splitting inside code blocks.
 */
export function formatForDiscord(text) {
  // Convert markdown tables to code block tables
  text = convertTables(text);

  if (text.length <= DISCORD_MAX_LENGTH) {
    return [text];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = findSplitPoint(remaining, DISCORD_MAX_LENGTH);
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Find a safe split point that doesn't break code blocks.
 */
function findSplitPoint(text, maxLen) {
  const segment = text.slice(0, maxLen);

  // Check if we're inside a code block
  const openFences = (segment.match(/```/g) || []).length;
  const insideCodeBlock = openFences % 2 !== 0;

  if (insideCodeBlock) {
    const lastFenceStart = segment.lastIndexOf('```');
    if (lastFenceStart > 200) {
      return lastFenceStart;
    }
  }

  // Try to split at a paragraph boundary
  const lastDoubleNewline = segment.lastIndexOf('\n\n');
  if (lastDoubleNewline > maxLen * 0.5) {
    return lastDoubleNewline + 2;
  }

  // Try to split at a line boundary
  const lastNewline = segment.lastIndexOf('\n');
  if (lastNewline > maxLen * 0.5) {
    return lastNewline + 1;
  }

  return maxLen;
}

/**
 * Export utilities for memos.
 *
 * Provides CSV and NDJSON serialization of memo collections.
 */

/**
 * Escape a single CSV field per RFC 4180.
 *
 * Wraps the value in double quotes and escapes any internal double-quote
 * characters by doubling them. This keeps fields containing commas,
 * newlines, or quotes from breaking the row structure.
 *
 * @param {*} field - Value to escape. `null`/`undefined` become empty strings.
 * @returns {string} The quoted, escaped field.
 */
function csvEscape(field) {
  const value = field === null || field === undefined ? '' : String(field);
  return '"' + value.replace(/"/g, '""') + '"';
}

/**
 * Serialize a single memo into a CSV row.
 *
 * @param {Object} memo - The memo to serialize.
 * @returns {string} A CSV row (without trailing newline).
 */
function memoToCsvRow(memo) {
  const fields = [
    memo.id,
    memo.content,
    memo.createdAt,
    memo.updatedAt,
    memo.metadata,
  ];
  return fields.map(csvEscape).join(',');
}

/**
 * Export a collection of memos as a CSV document.
 *
 * @param {Array<Object>} memos - The memos to export.
 * @returns {string} The CSV document.
 */
function exportToCsv(memos) {
  const header = ['id', 'content', 'createdAt', 'updatedAt', 'metadata'];
  const lines = [header.map(csvEscape).join(',')];
  for (const memo of memos) {
    lines.push(memoToCsvRow(memo));
  }
  return lines.join('\n');
}

/**
 * Serialize a single memo into an NDJSON line.
 *
 * @param {Object} memo - The memo to serialize.
 * @returns {string} A single-line JSON object (without trailing newline).
 */
function memoToNdjsonLine(memo) {
  return JSON.stringify(memo);
}

/**
 * Export a collection of memos as NDJSON.
 *
 * Each memo is written as one complete JSON object per line, terminated by
 * a newline so the output is a valid `application/x-ndjson` document.
 *
 * @param {Array<Object>} memos - The memos to export.
 * @returns {string} The NDJSON document.
 */
function exportToNdjson(memos) {
  if (!memos || memos.length === 0) {
    return '';
  }
  return memos.map(memoToNdjsonLine).join('\n') + '\n';
}

/**
 * Build the response headers for an export in the requested format.
 *
 * @param {'csv'|'json'} format - The requested export format.
 * @param {string} [filename] - Optional base filename (without extension).
 * @returns {Object} Headers including `Content-Type` and `Content-Disposition`.
 */
function exportHeaders(format, filename) {
  const base = filename || 'memos-export';
  if (format === 'json') {
    return {
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': `attachment; filename="${base}.ndjson"`,
    };
  }
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${base}.csv"`,
  };
}

/**
 * Serialize memos into the requested export format.
 *
 * @param {Array<Object>} memos - The memos to export.
 * @param {'csv'|'json'} [format='csv'] - The export format.
 * @returns {string} The serialized document.
 */
function exportMemos(memos, format) {
  if (format === 'json') {
    return exportToNdjson(memos);
  }
  return exportToCsv(memos);
}

module.exports = {
  csvEscape,
  memoToCsvRow,
  exportToCsv,
  memoToNdjsonLine,
  exportToNdjson,
  exportHeaders,
  exportMemos,
};

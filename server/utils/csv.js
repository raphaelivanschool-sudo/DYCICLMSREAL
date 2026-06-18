/**
 * Shared CSV export helpers for downloadable reports.
 *
 * One streamer used by every report (and the System Logs export) for a
 * consistent format: UTF-8 with BOM (so Excel reads accents correctly),
 * CRLF line endings, and RFC-4180 quoting/escaping. An empty `rows` array
 * yields a header-only file rather than an error.
 */

/** Reports never exceed this many data rows (guards memory + response size). */
export const EXPORT_MAX_ROWS = 25_000;

/** RFC-4180 escaping: wrap in quotes and double any embedded quotes. */
export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build the CSV text (BOM + header + rows) without sending it. */
export function buildCsv(header, rows) {
  const lines = [header.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

/**
 * Stream a CSV download response.
 * @param {import('express').Response} res
 * @param {{ filename: string, header: (string|number)[], rows: (string|number|null)[][] }} opts
 */
export function sendCsv(res, { filename, header, rows }) {
  const csv = buildCsv(header, rows || []);
  const safe = String(filename || 'report.csv').replace(/[^\w.\-]+/g, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
  res.send(csv);
}

/** YYYY-MM-DD for a Date (UTC-safe enough for filenames/labels). */
export function ymd(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * Parse an inclusive date range from `?start=YYYY-MM-DD&end=YYYY-MM-DD`.
 * Missing/invalid values fall back to the last 30 days. `lte` is pushed to
 * the end of the end-day so the final day is fully included.
 * @returns {{ gte: Date, lte: Date, startStr: string, endStr: string }}
 */
export function parseRange(query = {}) {
  const now = new Date();
  let gte = new Date(query.start);
  let lte = new Date(query.end);

  if (Number.isNaN(gte.getTime())) {
    gte = new Date(now);
    gte.setDate(gte.getDate() - 30);
  }
  if (Number.isNaN(lte.getTime())) {
    lte = new Date(now);
  }
  // Normalize to whole-day bounds.
  gte.setHours(0, 0, 0, 0);
  lte.setHours(23, 59, 59, 999);

  return { gte, lte, startStr: ymd(gte), endStr: ymd(lte) };
}

/** Minutes between two dates, rounded; null-safe. */
export function minutesBetween(start, end) {
  if (!start || !end) return 0;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.round(ms / 60000);
}

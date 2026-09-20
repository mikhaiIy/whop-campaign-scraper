import { htmlToText } from './html.js';

const TABLE_RE = /<table\b[^>]*>[\s\S]*?<\/table\s*>/gi;
const ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
const CELL_RE = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi;

export const hasTable = (html: string): boolean => /<table\b/i.test(html);

export function hasMultiColumnTable(html: string): boolean {
  for (const table of html.matchAll(TABLE_RE)) {
    for (const row of table[0].matchAll(ROW_RE)) {
      if ((row[1].match(CELL_RE) ?? []).length >= 2) return true;
    }
  }
  return false;
}

export function countTables(html: string): number {
  return (html.match(TABLE_RE) ?? []).length;
}

const cellText = (html: string): string => htmlToText(html).replace(/\s*\n+\s*/g, ' ').trim();

export function renderTable(tableHtml: string): string {
  const rows: string[][] = [];
  for (const row of tableHtml.matchAll(ROW_RE)) {
    const cells: string[] = [];
    for (const cell of row[1].matchAll(CELL_RE)) cells.push(cellText(cell[1]));
    if (cells.some(Boolean) || cells.length > 0) rows.push(cells);
  }
  if (!rows.length) return '';
  const width = Math.max(...rows.map(row => row.length));
  if (width <= 1) return rows.flat().filter(Boolean).join('\n');
  const headers = Array.from({ length: width }, (_, index) => rows[0][index] || `col${index + 1}`);
  const lines = [`TABLE HEADERS: ${headers.join(' | ')}`];
  for (const row of rows.slice(1)) {
    const labelled = Array.from({ length: width }, (_, index) => `${headers[index]}: ${row[index] || '(empty)'}`);
    lines.push(labelled.join(' | '));
  }
  return lines.join('\n');
}

export function htmlToTextWithTables(html: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const match of html.matchAll(TABLE_RE)) {
    const before = htmlToText(html.slice(cursor, match.index));
    if (before) parts.push(before);
    const table = renderTable(match[0]);
    if (table) parts.push(table);
    cursor = match.index + match[0].length;
  }
  const after = htmlToText(html.slice(cursor));
  if (after) parts.push(after);
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

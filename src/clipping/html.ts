const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', copy: '©', trade: '™',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function htmlToText(html: string): string {
  const withoutHidden = html.replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const withBreaks = withoutHidden
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|blockquote|pre)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(withBreaks)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const DOC_ID = /^\/document\/d\/([a-zA-Z0-9_-]+)/;

export function googleDocExportUrl(rawUrl: string, format: 'txt' | 'html' = 'txt'): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== 'docs.google.com' && !url.hostname.endsWith('.docs.google.com')) return null;
    const match = url.pathname.match(DOC_ID);
    if (!match) return null;
    return `https://docs.google.com/document/d/${match[1]}/export?format=${format}`;
  } catch { return null; }
}

export function withLineNumbers(text: string): string {
  const lines = text.split('\n');
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width)}: ${line}`).join('\n');
}

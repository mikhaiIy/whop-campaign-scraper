export type RecordValue = Record<string, unknown>;

export function flightText(html: string): string {
  if (!html.includes('<')) return html;
  const chunks: string[] = [];
  for (const match of html.matchAll(/self\.__next_f\.push\((.*?)\)<\/script>/gs)) {
    try {
      const value: unknown = JSON.parse(match[1]);
      if (Array.isArray(value) && value[0] === 1 && typeof value[1] === 'string') chunks.push(value[1]);
    } catch { continue; }
  }
  return chunks.join('');
}

export function jsonAt(text: string, start: number): unknown {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      if (--depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('Truncated JSON in the public RSC payload');
}

export function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function extractCampaigns(html: string): RecordValue[] {
  const text = flightText(html);
  const found = new Map<string, RecordValue>();
  for (const match of text.matchAll(/"campaigns"\s*:\s*(?=\[)/g)) {
    try {
      const values = jsonAt(text, match.index! + match[0].length);
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (isRecord(value) && typeof value.id === 'string' && typeof value.budgetTotalRaw === 'number' && typeof value.availableBudgetRaw === 'number') found.set(value.id, value);
      }
    } catch { continue; }
  }
  if (!found.size) throw new Error(`Campaign extraction failed: 0 valid campaigns in ${html.length} characters (${text.length} decoded flight characters). Expected campaigns with budgetTotalRaw and availableBudgetRaw. The public page format may have changed.`);
  return [...found.values()];
}

export function extractDetail(html: string, id: string): RecordValue {
  const text = flightText(html);
  for (const match of text.matchAll(/"card"\s*:\s*(?=\{)/g)) {
    try {
      const value = jsonAt(text, match.index! + match[0].length);
      if (isRecord(value) && value.id === id) return value;
    } catch { continue; }
  }
  throw new Error(`Detail extraction failed for ${id}: public campaign card missing from RSC payload`);
}

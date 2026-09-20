export type LinkKind = 'brief_doc' | 'footage_drive' | 'footage_channel' | 'community' | 'form' | 'brand_site' | 'unknown';

export interface ClassifiedLink {
  url: string;
  host: string;
  kind: LinkKind;
  mediaType: string | null;
}

const BINARY_MEDIA_TYPES = new Set(['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'zip', 'rar', '7z', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'mp4', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'm4a', 'ogg', 'psd', 'ai', 'eps']);

export const isBinaryMediaType = (mediaType: string | null | undefined): boolean =>
  typeof mediaType === 'string' && BINARY_MEDIA_TYPES.has(mediaType.trim().toLowerCase().replace(/^\./, ''));

export interface ReferenceMaterial {
  url?: unknown;
  [key: string]: unknown;
}

const hostEnds = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

interface HostRule {
  kind: LinkKind;
  match: (host: string, path: string) => boolean;
}

const RULES: HostRule[] = [
  { kind: 'form', match: (h, p) => hostEnds(h, 'docs.google.com') && /^\/forms\//.test(p) },
  { kind: 'brief_doc', match: h => hostEnds(h, 'docs.google.com') },
  { kind: 'brief_doc', match: h => hostEnds(h, 'notion.so') || hostEnds(h, 'notion.site') },
  { kind: 'footage_drive', match: h => hostEnds(h, 'drive.google.com') },
  { kind: 'footage_channel', match: h => hostEnds(h, 'youtube.com') || hostEnds(h, 'youtu.be') || hostEnds(h, 'youtube-nocookie.com') },
  { kind: 'footage_channel', match: h => hostEnds(h, 'kick.com') || hostEnds(h, 'twitch.tv') || hostEnds(h, 'vimeo.com') },
  { kind: 'footage_drive', match: h => hostEnds(h, 'mediasilo.com') },
  { kind: 'footage_drive', match: h => hostEnds(h, 'loom.com') || hostEnds(h, 'frame.io') || hostEnds(h, 'f.io') },
  { kind: 'footage_drive', match: h => hostEnds(h, 'mega.nz') || hostEnds(h, 'dropbox.com') || hostEnds(h, 'wetransfer.com') || hostEnds(h, 'terrahq.com') },
  { kind: 'form', match: h => hostEnds(h, 'forms.gle') || hostEnds(h, 'typeform.com') || hostEnds(h, 'jotform.com') || hostEnds(h, 'airtable.com') },
  { kind: 'community', match: h => hostEnds(h, 'discord.gg') || hostEnds(h, 'discord.com') || hostEnds(h, 't.me') || hostEnds(h, 'telegram.me') || hostEnds(h, 'telegram.org') },
  { kind: 'community', match: h => hostEnds(h, 'whop.com') },
  { kind: 'brand_site', match: h => hostEnds(h, 'instagram.com') || hostEnds(h, 'tiktok.com') || hostEnds(h, 'facebook.com') || hostEnds(h, 'x.com') || hostEnds(h, 'twitter.com') || hostEnds(h, 'linkedin.com') },
];

const parseUrl = (raw: string): URL | null => {
  const value = raw.trim().replace(/['",;)\]]+$/, '');
  if (!value || /^(mailto|tel|javascript|data):/i.test(value)) return null;
  for (const candidate of [value, `https://${value}`]) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url;
    } catch { continue; }
  }
  return null;
};

export function classifyLink(rawUrl: string, mediaType: string | null = null): ClassifiedLink {
  const url = parseUrl(rawUrl);
  if (!url) return { url: rawUrl.trim(), host: '', kind: 'unknown', mediaType };
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const rule of RULES) {
    if (rule.match(host, url.pathname)) return { url: url.toString(), host, kind: rule.kind, mediaType };
  }
  return { url: url.toString(), host, kind: host.includes('.') ? 'brand_site' : 'unknown', mediaType };
}

export function referenceUrls(materials: unknown): string[] {
  if (!Array.isArray(materials)) return [];
  const urls: string[] = [];
  for (const item of materials) {
    const value = typeof item === 'string' ? item : (item && typeof item === 'object' && typeof (item as ReferenceMaterial).url === 'string' ? (item as ReferenceMaterial).url as string : '');
    if (value) urls.push(value);
  }
  return urls;
}

export function classifyReferences(materials: unknown): ClassifiedLink[] {
  const seen = new Set<string>();
  const links: ClassifiedLink[] = [];
  if (!Array.isArray(materials)) return links;
  for (const item of materials) {
    const url = typeof item === 'string' ? item : (item && typeof item === 'object' && typeof (item as ReferenceMaterial).url === 'string' ? (item as ReferenceMaterial).url as string : '');
    if (!url) continue;
    const rawType = item && typeof item === 'object' ? (item as ReferenceMaterial).mediaType : null;
    const mediaType = typeof rawType === 'string' ? rawType : null;
    const link = classifyLink(url, mediaType);
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    links.push(link);
  }
  return links;
}

export const isChannel = (kind: LinkKind): boolean => kind === 'footage_channel';

export const isTextFetchable = (kind: LinkKind): boolean =>
  kind === 'brief_doc' || kind === 'brand_site' || kind === 'community' || kind === 'form';

export function unwrapRedirectUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if ((url.hostname === 'google.com' || url.hostname.endsWith('.google.com')) && url.pathname === '/url') {
      const target = url.searchParams.get('q');
      if (target && /^https?:\/\//i.test(target)) return target;
    }
  } catch { return raw; }
  return raw;
}

export function extractHttpLinks(html: string, base: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[1], base);
      if (url.protocol === 'http:' || url.protocol === 'https:') found.push(unwrapRedirectUrl(url.toString()));
    } catch { continue; }
  }
  return found;
}

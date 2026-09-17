import { matchKey, type Campaign, type CampaignPoint } from './normalize.js';
import type { RecordValue } from './parser.js';

export const API_ENDPOINT = 'https://contentrewards.com/api/campaign/campaigns/discover';
export const ASSET_BASE = 'https://content-rewards-production-publicassetsbucket-oxvzxvnr.s3.us-east-1.amazonaws.com/';

export const API_LIMITS = { pageSize: { min: 1, max: 100, default: 50 }, maxPages: { min: 1, max: 100, default: 5 }, pageDelayMs: { min: 0, max: 10_000, default: 500 } };

export interface ApiPagination { cursor?: string | null; nextCursor?: string | null; count?: number; limit?: number }
export interface ApiPage { data?: unknown; pagination?: ApiPagination | null; success?: boolean }

const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const numeric = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;

export function assetUrl(v: unknown): string | null {
  const value = text(v);
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `${ASSET_BASE}${value.replace(/^\/+/, '')}`;
}

export function moneyLabel(cents: number | null): string {
  if (cents === null || cents <= 0) return '$0';
  const dollars = cents / 100;
  for (const [unit, size] of [['M', 1e6], ['K', 1e3]] as const) {
    if (dollars >= size) {
      const scaled = dollars / size;
      const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
      return `$${rounded}${unit}`;
    }
  }
  return `$${Math.round(dollars * 100) / 100}`;
}

const rateLabel = (cents: number | null): string => cents === null ? '' : `$${Math.round(cents) / 100}`;

export function parseApiPage(value: unknown): ApiPage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Discover API returned a non-object payload');
  return value as ApiPage;
}

export function normalizeApi(raw: RecordValue, now = Date.now()): Campaign {
  const id = text(raw.id);
  if (!id) throw new Error('API campaign has no id');
  const metrics = typeof raw.metrics === 'object' && raw.metrics !== null && !Array.isArray(raw.metrics) ? raw.metrics as RecordValue : {};
  const totalCents = numeric(raw.budgetCents);
  const spentCents = numeric(metrics.budgetSpentCents);
  if (totalCents === null) throw new Error(`API campaign ${id} has no budgetCents`);
  const total = totalCents / 100;
  const spent = (spentCents ?? 0) / 100;
  const type = matchKey(text(raw.payoutType));
  const categories = Array.isArray(raw.categories)
    ? raw.categories.filter((c): c is RecordValue => typeof c === 'object' && c !== null && !Array.isArray(c)).map(c => text(c.name)).filter(Boolean)
    : [];
  const rateCents = numeric(raw.primaryPayoutCents) ?? numeric(raw.cpmMinRateCents) ?? numeric(raw.cpmMaxRateCents);
  const dollarsPerView = rateCents !== null ? rateCents / 100 / 1000 : 0;
  const chartPoints: CampaignPoint[] = Array.isArray(metrics.chartPoints)
    ? metrics.chartPoints.filter((p): p is RecordValue => typeof p === 'object' && p !== null && !Array.isArray(p)).map(p => {
      const views = numeric(p.totalViews) ?? 0;
      return {
        bucket: text(p.bucket),
        views,
        submissions: numeric(p.approvedSubmissionCount) ?? 0,
        spend: Math.round(views * dollarsPerView * 100) / 100,
      };
    }).filter(p => p.bucket).sort((a, b) => a.bucket.localeCompare(b.bucket))
    : [];
  const created = Date.parse(text(raw.createdAt));
  const createdAtMs = Number.isFinite(created) ? created : null;
  const ageDays = createdAtMs && createdAtMs > 0 ? (now - createdAtMs) / 86400000 : 0;
  const progressBps = numeric(metrics.budgetProgressBps);
  const progress = progressBps !== null ? progressBps / 100 : (total > 0 ? spent / total * 100 : 0);
  return {
    id, title: text(raw.name), brand: text(raw.organizationName), description: text(raw.description),
    category: categories[0]?.trim() || 'Uncategorized', type,
    platforms: Array.isArray(raw.platforms) ? raw.platforms.filter((p): p is string => typeof p === 'string').map(matchKey) : [],
    budgetTotal: total, budgetSpent: spent, budgetRemaining: Math.max(0, total - spent),
    cpmUsd: type === 'cpm' && rateCents !== null ? rateCents / 100 : null,
    ratePer1kLabel: rateLabel(rateCents),
    budgetTotalLabel: moneyLabel(totalCents), budgetSpentLabel: moneyLabel(spentCents),
    progressPercentage: progress, isNearlyExhausted: progress > 90,
    burnRatePerDay: ageDays > 0 ? spent / ageDays : null,
    burnRateBasis: 'Estimated lifetime average: spent divided by days since createdAtMs; not a recent spending trend.',
    creatorCount: numeric(metrics.creatorCount) ?? 0, submissionCount: numeric(metrics.approvedSubmissionCount) ?? 0,
    createdAtMs, requiresApplication: raw.requiresApplication === true, isVerified: raw.organizationVerified === true,
    thumbnail: assetUrl(raw.banner), organizationExperienceId: text(raw.organizationExperienceId) || null,
    url: `https://contentrewards.com/discover/${encodeURIComponent(id)}`,
    chartPoints,
  };
}

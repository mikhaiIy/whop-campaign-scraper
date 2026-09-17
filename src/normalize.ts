import type { RecordValue } from './parser.js';

export interface CampaignPoint {
  bucket: string;
  views: number;
  submissions: number;
  spend: number;
}

export interface Campaign {
  id: string;
  title: string;
  brand: string;
  description: string;
  category: string;
  type: string;
  platforms: string[];
  budgetTotal: number;
  budgetSpent: number;
  budgetRemaining: number;
  cpmUsd: number | null;
  ratePer1kLabel: string;
  budgetTotalLabel: string;
  budgetSpentLabel: string;
  progressPercentage: number;
  isNearlyExhausted: boolean;
  burnRatePerDay: number | null;
  burnRateBasis: string;
  creatorCount: number;
  submissionCount: number;
  createdAtMs: number | null;
  requiresApplication: boolean;
  isVerified: boolean;
  thumbnail: string | null;
  organizationExperienceId: string | null;
  url: string;
  chartPoints: CampaignPoint[];
}

const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const numeric = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const label = (v: unknown): string => text(v).replace(/\${2,}/g, '$');
export const matchKey = (v: string): string => v.trim().toLowerCase();

export function normalize(raw: RecordValue, now = Date.now()): Campaign {
  const id = text(raw.id);
  if (!id) throw new Error('Campaign has no id');
  const total = numeric(raw.budgetTotalRaw);
  const remaining = numeric(raw.availableBudgetRaw);
  if (total === null || remaining === null) throw new Error(`Campaign ${id} has invalid numeric budgets`);
  const spent = numeric(raw.budgetSpentRaw) ?? Math.max(0, total - remaining);
  const created = numeric(raw.createdAtMs);
  const ageDays = created && created > 0 ? (now - created) / 86400000 : 0;
  const type = matchKey(text(raw.type));
  const rateLabel = label(raw.ratePer1kLabel);
  const parsedRate = Number(rateLabel.replace(/[$,]/g, ''));
  const rate = numeric(raw.payoutSortRaw) ?? (rateLabel && Number.isFinite(parsedRate) ? parsedRate : null);
  const progress = numeric(raw.progressPercentage) ?? (total > 0 ? spent / total * 100 : 0);
  return {
    id, title: text(raw.title), brand: text(raw.brand), description: text(raw.description),
    category: text(raw.category) || 'Uncategorized', type,
    platforms: Array.isArray(raw.platforms) ? raw.platforms.filter((p): p is string => typeof p === 'string').map(matchKey) : [],
    budgetTotal: total, budgetSpent: spent, budgetRemaining: remaining,
    cpmUsd: type === 'cpm' ? rate : null,
    ratePer1kLabel: rateLabel, budgetTotalLabel: label(raw.budgetTotalLabel), budgetSpentLabel: label(raw.budgetSpentLabel),
    progressPercentage: progress, isNearlyExhausted: progress > 90,
    burnRatePerDay: ageDays > 0 ? spent / ageDays : null,
    burnRateBasis: 'Estimated lifetime average: spent divided by days since createdAtMs; not a recent spending trend.',
    creatorCount: numeric(raw.creatorCountRaw) ?? 0, submissionCount: numeric(raw.submissionCountRaw) ?? 0,
    createdAtMs: created, requiresApplication: raw.requiresApplication === true, isVerified: raw.isVerified === true,
    thumbnail: text(raw.thumbnail) || null, organizationExperienceId: text(raw.organizationExperienceId) || null,
    url: `https://contentrewards.com/discover/${encodeURIComponent(id)}`,
    chartPoints: [],
  };
}

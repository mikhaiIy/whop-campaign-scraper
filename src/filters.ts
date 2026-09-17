import { z } from 'zod';
import { type Campaign, matchKey } from './normalize.js';

export const filterShape = {
  categories: z.array(z.string().trim().min(1)).optional(),
  platforms: z.array(z.string().trim().min(1)).optional(),
  type: z.string().trim().min(1).optional(),
  min_cpm: z.number().nonnegative().optional(),
  max_cpm: z.number().nonnegative().optional(),
  min_budget_remaining: z.number().nonnegative().optional(),
  requires_application: z.boolean().optional(),
  is_verified: z.boolean().optional(),
  sort_by: z.enum(['newest', 'cpm', 'budget_remaining', 'creator_count']).optional(),
  limit: z.number().int().min(1).max(500).optional(),
};
export const filterSchema = z.object(filterShape).strict();
export type Filters = z.infer<typeof filterSchema>;

export function filterCampaigns(campaigns: Campaign[], filters: Filters = {}): Campaign[] {
  if (filters.min_cpm !== undefined && filters.max_cpm !== undefined && filters.min_cpm > filters.max_cpm) {
    throw new Error('min_cpm must be less than or equal to max_cpm');
  }
  const categories = filters.categories?.map(matchKey);
  const platforms = filters.platforms?.map(matchKey);
  const filtered = campaigns.filter(c =>
    (!categories?.length || categories.includes(matchKey(c.category))) &&
    (!platforms?.length || c.platforms.some(p => platforms.includes(matchKey(p)))) &&
    (filters.type === undefined || c.type === matchKey(filters.type)) &&
    (filters.min_cpm === undefined || (c.cpmUsd !== null && c.cpmUsd >= filters.min_cpm)) &&
    (filters.max_cpm === undefined || (c.cpmUsd !== null && c.cpmUsd <= filters.max_cpm)) &&
    (filters.min_budget_remaining === undefined || c.budgetRemaining >= filters.min_budget_remaining) &&
    (filters.requires_application === undefined || c.requiresApplication === filters.requires_application) &&
    (filters.is_verified === undefined || c.isVerified === filters.is_verified)
  );
  const score = (c: Campaign): number => {
    switch (filters.sort_by ?? 'newest') {
      case 'cpm': return c.cpmUsd ?? -Infinity;
      case 'budget_remaining': return c.budgetRemaining;
      case 'creator_count': return c.creatorCount;
      case 'newest': return c.createdAtMs ?? -Infinity;
    }
  };
  return filtered.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id)).slice(0, filters.limit ?? 50);
}

export function categoryCounts(campaigns: Campaign[]): { category: string; count: number }[] {
  const counts = new Map<string, { category: string; count: number }>();
  for (const c of campaigns) {
    const key = matchKey(c.category);
    const entry = counts.get(key) ?? { category: c.category, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => a.category.localeCompare(b.category));
}

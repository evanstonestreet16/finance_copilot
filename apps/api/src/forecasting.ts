import { prisma } from '@copilot/db/dist/index.js';
import { loadPretrainedArtifact, predictWithPretrained, PretrainedArtifact } from './pretrainedModel.js';

export type MonthIndex = number;

export type MonthlyCategoryTotal = {
  monthKey: string; // '2025-06-01'
  category: string; // 'Dining', 'Transport', 'Income', etc.
  totalAmount: number; // sum of amounts in that month/category
};

export type CategorySeriesPoint = { monthKey: string; index: MonthIndex; amount: number };

export type CategorySeries = {
  category: string;
  months: CategorySeriesPoint[];
};

export type ForecastResult = {
  nextMonthKey: string;
  perCategory: { category: string; predicted: number }[];
  totalPredicted: number;
};

export type SafeToSpend = {
  targetSavingsRate: number;
  avgMonthlyIncome: number | null;
  safeTotalBudget: number | null;
  perCategory: { category: string; safeBudget: number | null; predicted: number }[];
};

export type HistoryPoint = {
  monthKey: string;
  perCategory: { category: string; actual: number }[];
  totalActual: number;
};

export const CANONICAL_CATEGORIES = [
  'Dining',
  'Groceries',
  'Subscriptions',
  'Transport',
  'Uncategorized',
  'Other',
  'Income',
] as const;

const TARGET_SAVINGS_RATE = 0.2;
const AVG_INCOME_MONTHS = 3;

export async function getMonthlyCategoryTotals(
  accountId?: string
): Promise<MonthlyCategoryTotal[]> {
  const params: any[] = [];
  const where: string[] = [];

  if (accountId) {
    where.push(`"accountId" = $${params.length + 1}`);
    params.push(accountId);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await prisma.$queryRawUnsafe<Array<MonthlyCategoryTotal>>(
    `
      SELECT
        to_char(date_trunc('month', "ts"), 'YYYY-MM-01') AS "monthKey",
        COALESCE(category, 'Other') AS category,
        SUM(amount)::float AS "totalAmount"
      FROM "Transaction"
      ${whereSql}
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC
    `,
    ...params
  );

  return rows;
}

export function buildCategorySeries(rows: MonthlyCategoryTotal[]): CategorySeries[] {
  const byCategory = new Map<string, CategorySeriesPoint[]>();

  // Sort rows chronologically to assign indices
  const sorted = [...rows].sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  const uniqueMonths = Array.from(new Set(sorted.map(r => r.monthKey)));
  const monthIndex = new Map(uniqueMonths.map((m, idx) => [m, idx]));

  for (const r of sorted) {
    const idx = monthIndex.get(r.monthKey) ?? 0;
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category)!.push({ monthKey: r.monthKey, index: idx, amount: r.totalAmount });
  }

  const categories = new Set<string>([
    ...CANONICAL_CATEGORIES,
    ...Array.from(byCategory.keys()),
  ]);

  return Array.from(categories).map(category => ({
    category,
    months: (byCategory.get(category) || []).sort((a, b) => a.index - b.index),
  }));
}

export function holtLinearPredict(
  series: { index: number; amount: number }[],
  alpha = 0.6,
  beta = 0.3
): number {
  const n = series.length;
  if (n === 0) return 0;
  if (n === 1) return series[0].amount;

  // Initialize level and trend using first two points
  let level = series[0].amount;
  let trend = series[1].amount - series[0].amount;

  for (let i = 1; i < n; i++) {
    const y = series[i].amount;
    const prevLevel = level;
    level = alpha * y + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }

  const nextT = series[n - 1].index + 1;
  return level + trend * (nextT - series[n - 1].index);
}

export function forecastPerCategory(
  series: CategorySeries[],
  artifact?: PretrainedArtifact | null
): ForecastResult {
  // Find last monthKey in the data
  const allMonths = series.flatMap(s => s.months.map(m => m.monthKey));
  const lastMonthKey = allMonths.sort().slice(-1)[0];
  const nextMonthKey = formatNextMonthKey(lastMonthKey);

  // Try pre-trained artifact first
  const pretrainedPreds = predictWithPretrained(series, artifact ?? null);
  const perCategory =
    pretrainedPreds && pretrainedPreds.length
      ? pretrainedPreds
      : series
          .filter(s => s.category.toLowerCase() !== 'income')
          .map(s => ({
            category: s.category,
            predicted: holtLinearPredict(s.months),
          }));

  const totalPredicted = perCategory.reduce((acc, c) => acc + Math.max(0, c.predicted), 0);

  return { nextMonthKey, perCategory, totalPredicted };
}

export function computeSafeToSpend(
  forecast: ForecastResult,
  series: CategorySeries[]
): SafeToSpend {
  const incomeSeries =
    series.find(s => s.category.toLowerCase() === 'income') ||
    series.find(s => s.category.toLowerCase().includes('income'));

  const incomeMonths = incomeSeries?.months ?? [];
  const lastIncome = incomeMonths.slice(-AVG_INCOME_MONTHS);
  const avgMonthlyIncome =
    lastIncome.length > 0
      ? lastIncome.reduce((sum, m) => sum + Math.abs(m.amount), 0) / lastIncome.length
      : null;

  if (!avgMonthlyIncome || !isFinite(avgMonthlyIncome)) {
    return {
      targetSavingsRate: TARGET_SAVINGS_RATE,
      avgMonthlyIncome: null,
      safeTotalBudget: null,
      perCategory: forecast.perCategory.map(pc => ({
        category: pc.category,
        predicted: pc.predicted,
        safeBudget: null,
      })),
    };
  }

  const safeTotalBudget = avgMonthlyIncome * (1 - TARGET_SAVINGS_RATE);
  const sumPredicted = forecast.perCategory.reduce(
    (sum, pc) => sum + Math.max(0, pc.predicted),
    0
  );

  const numCategories = forecast.perCategory.length || 1;
  const perCategory = forecast.perCategory.map(pc => {
    const ratio = sumPredicted > 0 ? Math.max(0, pc.predicted) / sumPredicted : 1 / numCategories;
    const safeBudget = safeTotalBudget * ratio;
    return { category: pc.category, predicted: pc.predicted, safeBudget };
  });

  return {
    targetSavingsRate: TARGET_SAVINGS_RATE,
    avgMonthlyIncome,
    safeTotalBudget,
    perCategory,
  };
}

export function buildHistory(rows: MonthlyCategoryTotal[]): HistoryPoint[] {
  const byMonth = new Map<string, MonthlyCategoryTotal[]>();
  for (const r of rows) {
    if (!byMonth.has(r.monthKey)) byMonth.set(r.monthKey, []);
    byMonth.get(r.monthKey)!.push(r);
  }

  return Array.from(byMonth.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monthKey, vals]) => {
      const perCategory = vals.map(v => ({
        category: v.category,
        actual: v.totalAmount,
      }));
      const totalActual = vals
        .filter(v => v.category.toLowerCase() !== 'income')
        .reduce((sum, v) => sum + Math.max(0, v.totalAmount), 0);
      return { monthKey, perCategory, totalActual };
    });
}

export function fallbackForecast(rows: MonthlyCategoryTotal[]): ForecastResult {
  const byCategory = new Map<string, MonthlyCategoryTotal[]>();
  for (const r of rows) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category)!.push(r);
  }
  const latestMonth = rows.map(r => r.monthKey).sort().slice(-1)[0];
  const nextMonthKey = formatNextMonthKey(latestMonth);

  const perCategory = Array.from(byCategory.entries())
    .filter(([cat]) => cat.toLowerCase() !== 'income')
    .map(([category, vals]) => {
      const last = vals.sort((a, b) => a.monthKey.localeCompare(b.monthKey)).slice(-1)[0];
      return { category, predicted: last?.totalAmount ?? 0 };
    });

  const totalPredicted = perCategory.reduce((sum, p) => sum + Math.max(0, p.predicted), 0);
  return { nextMonthKey, perCategory, totalPredicted };
}

function formatNextMonthKey(lastMonthKey: string): string {
  const d = new Date(lastMonthKey);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, '0');
  return `${y}-${m}-01`;
}

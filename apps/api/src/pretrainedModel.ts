import fs from 'fs';
import path from 'path';
import { CategorySeries } from './forecasting.js';

export type PretrainedCategoryModel = {
  intercept: number;
  lags: number[]; // coefficients for lag-1, lag-2, ...
};

export type PretrainedArtifact = {
  version: string;
  trainedAt: string;
  categories: Record<string, PretrainedCategoryModel>;
  default?: PretrainedCategoryModel;
};

const ARTIFACT_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'model_artifacts',
  'sample_pretrained.json'
);

export function loadPretrainedArtifact(): PretrainedArtifact | null {
  try {
    if (!fs.existsSync(ARTIFACT_PATH)) return null;
    const raw = fs.readFileSync(ARTIFACT_PATH, 'utf-8');
    return JSON.parse(raw) as PretrainedArtifact;
  } catch (err) {
    // If artifact cannot be read or parsed, fall back to runtime model
    return null;
  }
}

export function predictWithPretrained(
  series: CategorySeries[],
  artifact: PretrainedArtifact | null
): { category: string; predicted: number }[] | null {
  if (!artifact) return null;

  const predictions: { category: string; predicted: number }[] = [];

  for (const catSeries of series) {
    if (catSeries.category.toLowerCase() === 'income') continue;
    const model = artifact.categories[catSeries.category] || artifact.default;
    if (!model) continue;
    const sorted = [...catSeries.months].sort((a, b) => a.index - b.index);
    const n = sorted.length;
    if (n === 0) {
      predictions.push({ category: catSeries.category, predicted: 0 });
      continue;
    }
    // Build lags from most recent months
    const lags = model.lags;
    let pred = model.intercept;
    for (let i = 0; i < lags.length; i++) {
      const lagVal = sorted[n - 1 - i]?.amount ?? sorted[0].amount;
      pred += lags[i] * lagVal;
    }
    predictions.push({ category: catSeries.category, predicted: pred });
  }

  return predictions;
}

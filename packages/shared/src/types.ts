export type ImportBatch = {
  id: string;
  createdAt: Date;
  filename?: string;
  recordCount: number;
  accountId?: string;
};

export type Transaction = {
  id?: string;
  accountId?: string;
  ts: string; // ISO date
  amount: number;
  currency?: string;
  description: string;
  merchant?: string;
  category?: string;
  source?: 'csv' | 'plaid' | 'manual';
  batchId?: string;
  externalId?: string;
};

export type CategoryTotal = { category: string; total: number };

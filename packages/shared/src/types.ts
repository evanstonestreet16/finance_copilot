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
};

export type CategoryTotal = { category: string; total: number };

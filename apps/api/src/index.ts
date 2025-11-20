

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { prisma } from '@copilot/db/dist/index.js';
import {
  buildCategorySeries,
  buildHistory,
  computeSafeToSpend,
  fallbackForecast,
  forecastPerCategory,
  getMonthlyCategoryTotals,
} from './forecasting.js';
import { loadPretrainedArtifact } from './pretrainedModel.js';
import { parse } from 'csv-parse';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const server = Fastify({ logger: true });
const PORT = Number(process.env.PORT || 4000);
const ORIGIN = (process.env.ORIGIN || '').split(',').filter(Boolean);

// --- helpers (add near the top of the file, below constants) ---
function monthRange(ym?: string) {
  if (!ym) return null;
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1); // exclusive
  return { start, end };
}

function mape(actual: number[], pred: number[]) {
  const n = Math.min(actual.length, pred.length);
  if (n === 0) return NaN;
  let err = 0;
  for (let i = 0; i < n; i++) {
    const a = actual[i] || 1; // avoid divide-by-zero
    err += Math.abs((actual[i] - pred[i]) / a);
  }
  return (err / n) * 100;
}


server.get('/health', async () => ({ ok: true }));

server.post('/import', async (req, reply) => {
  const parts = req.parts(); // async iterator
  let accountName: string | undefined;
  let filename: string | undefined;
  const records: any[] = [];

  for await (const part of parts) {
    if (part.type === 'file') {
      filename = part.filename;
      const tmpPath = path.join(os.tmpdir(), `${Date.now()}_${filename}`);
      await fs.promises.writeFile(tmpPath, await part.toBuffer());

      const parser = fs.createReadStream(tmpPath).pipe(
        parse({ columns: true, skip_empty_lines: true })
      );
      for await (const r of parser as any) records.push(r);
      await fs.promises.unlink(tmpPath);
    } else if (part.type === 'field' && part.fieldname === 'accountName') {
      accountName = String(part.value ?? '');
    }
  }

  if (!records.length) {
    reply.code(400);
    return { error: 'No CSV records parsed' };
  }

  const account = await prisma.account.upsert({
    where: { id: accountName || 'default' },
    create: { id: accountName || 'default', name: accountName || 'Default' },
    update: {}
  });

  // Create an import batch
  const batch = await prisma.importBatch.create({
    data: {
      filename,
      recordCount: records.length,
      accountId: account.id
    }
  });

  const rules: Record<string, string> = {
    STARBUCKS: 'Dining',
    UBER: 'Transport',
    LYFT: 'Transport',
    SPOTIFY: 'Subscriptions',
    NETFLIX: 'Subscriptions',
    WALMART: 'Groceries',
    KROGER: 'Groceries',
  };

  const txns = records.map((r: any, idx: number) => {
    // Coerce safely using String(...) to avoid calling toString on undefined
    const desc: string = String(r.description ?? r.Description ?? r.DESC ?? '');
    const amtStr = String(r.amount ?? r.Amount ?? r.AMOUNT ?? '0').replace(/,/g, '');
    const amt = Number(amtStr);
    const dateStr = String(r.date ?? r.Date ?? r.DATE ?? '');
    const merchant = String(r.merchant ?? r.Merchant ?? '');
    const ts = new Date(dateStr);

    // Basic validation: if date or amount invalid, throw with context
    if (Number.isNaN(amt) || !dateStr || Number.isNaN(ts.getTime())) {
      throw new Error(`Invalid CSV row at index ${idx}: date='${dateStr}', amount='${amtStr}'`);
    }

    const key = (merchant || desc).toUpperCase();
    const matched = Object.keys(rules).find(k => key.includes(k));
    const category = matched ? rules[matched] : (amt < 0 ? 'Income' : 'Uncategorized');

    // Create a unique external ID based on transaction details
    const externalId = Buffer.from(`${dateStr}|${amt}|${desc}|${merchant}`).toString('base64');

    return {
      accountId: account.id,
      ts,
      amount: amt,
      description: desc,
      merchant,
      category,
      source: 'csv',
      batchId: batch.id,
      externalId
    };
  });

  // Find existing transactions to avoid duplicates
  const existingIds = new Set((await prisma.transaction.findMany({
    where: {
      externalId: { in: txns.map(t => t.externalId) }
    },
    select: { externalId: true }
  })).map(t => t.externalId));

  // Filter out duplicates
  const newTxns = txns.filter(t => !existingIds.has(t.externalId));

  // Insert in chunks
  let inserted = 0;
  for (let i = 0; i < newTxns.length; i += 500) {
    const result = await prisma.transaction.createMany({
      data: newTxns.slice(i, i + 500)
    });
    inserted += result.count;
  }

  // Update batch count to reflect actual inserts
  await prisma.importBatch.update({
    where: { id: batch.id },
    data: { recordCount: inserted }
  });

  return {
    batchId: batch.id,
    total: records.length,
    inserted,
    skipped: records.length - inserted,
    accountId: account.id
  };
});

// REPLACE your existing /totals with this month-aware version
server.get('/totals', async (req, reply) => {
  const q = req.query as { month?: string; accountId?: string };
  const range = monthRange(q.month);

  // Build WHERE clause dynamically
  const where: string[] = [];
  const params: any[] = [];

  if (range) {
    where.push(`"ts" >= $${params.length + 1} AND "ts" < $${params.length + 2}`);
    params.push(range.start, range.end);
  }
  if (q.accountId) {
    where.push(`"accountId" = $${params.length + 1}`);
    params.push(q.accountId);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Use parameterized raw SQL for speed and simplicity
  const rows = await prisma.$queryRawUnsafe<Array<{ category: string | null; total: number }>>(
    `
      SELECT COALESCE(category, 'Uncategorized') as category,
             SUM(amount)::float as total
      FROM "Transaction"
      ${whereSql}
      GROUP BY category
      ORDER BY total DESC
    `,
    ...params
  );

  return { totals: rows };
});

// Get import history
server.get('/imports', async (req, reply) => {
  const q = req.query as { accountId?: string };
  const batches = await prisma.importBatch.findMany({
    where: q.accountId ? { accountId: q.accountId } : undefined,
    orderBy: { createdAt: 'desc' },
    include: {
      account: { select: { name: true } }
    }
  });
  return { batches };
});

// Get details of a specific import batch
server.get<{ Params: { batchId: string } }>('/imports/:batchId', async (req, reply) => {
  const { batchId } = req.params;
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: {
      account: { select: { name: true } },
      transactions: {
        orderBy: { ts: 'asc' },
        take: 100 // Limit sample size
      }
    }
  });
  if (!batch) {
    reply.code(404);
    return { error: 'Batch not found' };
  }
  return { batch };
});

// Delete a specific import batch and its transactions
server.delete<{ Params: { batchId: string } }>('/imports/:batchId', async (req, reply) => {
  const batch = await prisma.importBatch.findUnique({
    where: { id: req.params.batchId },
    include: { transactions: true }
  });
  
  if (!batch) {
    reply.code(404);
    return { error: 'Batch not found' };
  }

  // Delete in transaction to ensure atomicity
  const result = await prisma.$transaction([
    prisma.transaction.deleteMany({
      where: { batchId: batch.id }
    }),
    prisma.importBatch.delete({
      where: { id: batch.id }
    })
  ]);

  return {
    batchId: batch.id,
    deletedTransactions: result[0].count,
    success: true
  };
});

server.get('/', async () => ({
  name: 'Finance Copilot API',
  routes: [
    '/health',
    '/import (POST multipart form)',
    '/totals',
    '/imports (GET import history)',
    '/imports/:batchId (GET batch details)',
    '/imports/:batchId (DELETE batch)'
  ],
}));

// NEW: recurring detection
server.get('/recurring', async (req, reply) => {
  const rows = await prisma.$queryRawUnsafe<Array<{
    merchant: string | null;
    txn_count: number;
    months_count: number;
    avg_gap_days: number | null;
    total_abs: number;
  }>>(
    `
    WITH t AS (
      SELECT
        COALESCE(NULLIF(TRIM(merchant), ''), 'UNKNOWN') AS merchant,
        ts,
        ABS(amount)::float AS amount_abs
      FROM "Transaction"
      WHERE amount > 0
    ),
    g AS (
      SELECT
        merchant,
        ts,
        EXTRACT(EPOCH FROM (ts - LAG(ts) OVER (PARTITION BY merchant ORDER BY ts))) / 86400.0 AS gap_days,
        amount_abs
      FROM t
    ),
    agg AS (
      SELECT
        merchant,
        COUNT(*)::int AS txn_count,
        COUNT(DISTINCT date_trunc('month', ts))::int AS months_count,
        AVG(gap_days) FILTER (WHERE gap_days IS NOT NULL) AS avg_gap_days,
        SUM(amount_abs)::float AS total_abs
      FROM g
      GROUP BY merchant
    )
    SELECT merchant, txn_count, months_count, avg_gap_days, total_abs
    FROM agg
    WHERE txn_count >= 2 AND months_count >= 2
    ORDER BY total_abs DESC
    LIMIT 20
    `
  );

  return { recurring: rows };
});



// NEW: per-category forecast + safe-to-spend budgeting
server.get('/forecast', async (req, reply) => {
  const q = req.query as { accountId?: string };
  const totals = await getMonthlyCategoryTotals(q.accountId);

  if (!totals.length) {
    return {
      history: [],
      forecast: null,
      safeToSpend: null,
      note: 'No transaction history available',
    };
  }

  const history = buildHistory(totals);
  const series = buildCategorySeries(totals);
  const uniqueMonths = Array.from(new Set(totals.map(t => t.monthKey)));
  const artifact = loadPretrainedArtifact();

  const forecast =
    uniqueMonths.length >= 2 ? forecastPerCategory(series, artifact) : fallbackForecast(totals);

  const safeToSpend = computeSafeToSpend(forecast, series);

  return { history, forecast, safeToSpend };
});



async function start() {
  // Move top-level awaits into this function
  await server.register(cors, { origin: ORIGIN.length ? ORIGIN : true });
  await server.register(multipart);

  try {
    await server.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();

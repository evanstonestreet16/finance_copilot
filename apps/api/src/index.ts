import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { prisma } from '@copilot/db/dist/index.js';
import { parse } from 'csv-parse';
import * as fs from 'fs';

const server = Fastify({ logger: true });
const PORT = Number(process.env.PORT || 4000);
const ORIGIN = (process.env.ORIGIN || '').split(',').filter(Boolean);

server.get('/health', async () => ({ ok: true }));

server.post('/import', async (req, reply) => {
  const parts = req.parts(); // async iterator
  let accountName: string | undefined;
  const records: any[] = [];

  for await (const part of parts) {
    if (part.type === 'file') {
      const tmpPath = `/tmp/${Date.now()}_${part.filename}`;
      await fs.promises.writeFile(tmpPath, await part.toBuffer());

      const parser = fs.createReadStream(tmpPath).pipe(
        parse({ columns: true, skip_empty_lines: true })
      );
      for await (const r of parser as any) records.push(r);
      await fs.promises.unlink(tmpPath);
    } else if (part.type === 'field' && part.fieldname === 'accountName') {
      // part.value is typed as unknown; coerce safely to string
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

  const rules: Record<string, string> = {
    STARBUCKS: 'Dining',
    UBER: 'Transport',
    LYFT: 'Transport',
    SPOTIFY: 'Subscriptions',
    NETFLIX: 'Subscriptions',
    WALMART: 'Groceries',
    KROGER: 'Groceries',
  };

  const txns = records.map((r: any) => {
    const desc: string = (r.description || r.Description || r.DESC || '').toString();
    const amtStr = (r.amount || r.Amount || r.AMOUNT || '0').toString().replace(',', '');
    const amt = Number(amtStr);
    const dateStr = (r.date || r.Date || r.DATE).toString();
    const merchant = (r.merchant || r.Merchant || '').toString();

    const key = (merchant || desc).toUpperCase();
    const matched = Object.keys(rules).find(k => key.includes(k));
    const category = matched ? rules[matched] : (amt < 0 ? 'Income' : 'Uncategorized');

    return {
      accountId: account.id,
      ts: new Date(dateStr),
      amount: amt,
      description: desc,
      merchant,
      category,
      source: 'csv',
    };
  });

  for (let i = 0; i < txns.length; i += 500) {
    await prisma.transaction.createMany({
      data: txns.slice(i, i + 500),
      skipDuplicates: true,
    });
  }

  return { inserted: txns.length, accountId: account.id };
});

server.get('/totals', async () => {
  const totals = await prisma.$queryRawUnsafe<Array<{ category: string; total: number }>>(`
    SELECT COALESCE(category, 'Uncategorized') as category, SUM(amount)::float as total
    FROM "Transaction"
    GROUP BY category
    ORDER BY total DESC
  `);
  return { totals };
});

server.get('/', async () => ({
  name: 'Finance Copilot API',
  routes: ['/health', '/import (POST multipart form)', '/totals'],
}));

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

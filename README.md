# Finance Copilot Monorepo (Phase 0)

## What this includes
- **API (Fastify + TypeScript)**: CSV import and category totals endpoints.
- **DB (Postgres + Prisma)**: Transactions schema.
- **Mobile (Expo React Native)**: Simple list of category totals.

## Quick start
1. **Start Postgres**
   ```bash
   docker compose up -d
   ```

2. **Install deps**
   ```bash
   npm install
   ```

3. **Configure env for API**
   ```bash
   cp apps/api/.env.example apps/api/.env
   # edit if needed
   ```

4. **Generate Prisma client & migrate**
   ```bash
   npm run db:generate
   npm run db:migrate
   ```

5. **Run API**
   ```bash
   npm run dev:api
   ```

6. **Import a CSV**
   Use curl or Postman:
   ```bash
   curl -X POST http://localhost:4000/import      -H "Content-Type: multipart/form-data"      -F "accountName=checking"      -F "file=@/path/to/transactions.csv"
   ```
   CSV must have headers like `date,description,amount,merchant` (case-insensitive). Amount should be positive for expenses, negative for income.

7. **Run Mobile app (Expo)**
   ```bash
   cd apps/mobile
   npm install
   EXPO_PUBLIC_API_URL=http://localhost:4000 npm run web
   ```

You should see category totals update after importing a CSV.

## Notes
- This is Phase 0 scaffold; rules-based categorization is naive. We'll swap in ML later.
- For mobile on device/emulator, ensure the API host is reachable (adjust EXPO_PUBLIC_API_URL).

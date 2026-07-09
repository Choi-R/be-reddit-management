# Reddit Account Management CRM - Backend API

This directory contains the edge-optimized serverless API backend for the Reddit Account Management CRM. The backend is built using the Hono framework, written in TypeScript, and runs on Cloudflare Workers, connecting to Neon Serverless Postgres.

---

## Technology Stack

- **Framework**: [Hono](https://hono.dev/) (ultralight, fast web framework designed for edge runtimes)
- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/) (V8 isolates running globally on the edge)
- **Database**: [Neon.com](https://neon.tech/) (Managed serverless PostgreSQL database with scale-to-zero compute)
- **Database Client**: `@neondatabase/serverless` (Neon WebSocket driver optimizing connection scaling)
- **Aesthetics & Logic**: WebCrypto API for secure SHA-256 password hashing and JWT token signatures on the edge

---

## Local Setup & Development

Follow these steps to run the backend API server on your local machine:

### 1. Database Initialization
1. Log in to your [Neon Console](https://neon.tech/) and navigate to your project branch.
2. Open the **SQL Editor** tab.
3. Open [database/schema.sql](file:///d:/Portfolio/Reddit%20Management/be-reddit-management/database/schema.sql) in this workspace, copy the SQL commands, paste them into Neon's SQL Editor, and click **Run**.
4. This creates all tables, triggers for automated `updated_at` values, indexes for 100+ accounts, and seeds lookup data alongside a default Admin user:
   - **Email**: `admin@redditcrm.com`
   - **Password**: `AdminCRM2026!`

### 2. Configure Environment Secrets
1. In the [be-reddit-management](file:///d:/Portfolio/Reddit%20Management/be-reddit-management) folder, copy the template `.dev.vars.example` and name the copy **`.dev.vars`**.
2. Open **`.dev.vars`** and populate the variables:
   - `DATABASE_URL`: Your Neon Postgres connection string.
   - `JWT_SECRET`: A secure random string for JWT signatures.
   - `CRON_SECRET`: A secure key used to authorize background cron cleanups.

### 3. Run the Development Server
Install dependencies and launch the local Wrangler edge emulator:
```bash
npm install
npm run dev
```
The server will boot on **`http://localhost:8787`**.

### 4. Execute the E2E Integration Tests
With the server running in one terminal, open a secondary terminal and execute the test runner to verify all API endpoints and booking transactions:
```bash
node test-api.js
```
You should see:
`🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY! The backend is 100% functional.`

---

## Production Edge Deployment

When you are ready to publish the backend to Cloudflare's edge:

1. Deploy the compiled bundle:
   ```bash
   npx wrangler deploy
   ```
2. Upload environment secrets to Cloudflare (do not store passwords/keys in files in Git):
   ```bash
   npx wrangler secret put DATABASE_URL
   npx wrangler secret put JWT_SECRET
   npx wrangler secret put CRON_SECRET
   ```
3. Cloudflare will automatically activate the Cron Trigger (defined in `wrangler.toml`) to execute hourly task sweeps in production.

---
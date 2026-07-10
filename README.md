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

## Production Deployment via GitHub Actions

This repository is configured with a GitHub Actions workflow to build and deploy the API automatically to Cloudflare Workers on every `git push` to `master` or `main`.

### 1. Configure Cloudflare API Token in GitHub
To authorize GitHub to deploy to your Cloudflare account:
1. Log in to your [Cloudflare Dashboard](https://dash.cloudflare.com/) and go to **My Profile > API Tokens**.
2. Click **Create Token** and select the **Edit Cloudflare Workers** template.
3. Keep the default permissions (Workers: Write, Account Settings: Read) and copy the generated token.
4. Go to your GitHub repository (**Choi-R/be-reddit-management**).
5. Navigate to **Settings > Secrets and variables > Actions > New repository secret**.
6. Name the secret **`CLOUDFLARE_API_TOKEN`** and paste your API token.

### 2. Configure Production Database Secrets
Secrets must be stored securely on Cloudflare so they are not committed to code history:
1. Inside your Cloudflare Workers Dashboard, select your deployed **be-reddit-management** worker.
2. Go to **Settings > Variables > Variables and Secrets** (or run these once in your terminal):
   ```bash
   npx wrangler secret put DATABASE_URL  # Enter your Neon connection string
   npx wrangler secret put JWT_SECRET     # Enter your JWT signature passphrase
   npx wrangler secret put CRON_SECRET    # Enter your Cron cleanup token
   ```

### 3. Automated Release
When you run `git push origin master`, the action at `.github/workflows/deploy.yml` compiles your Hono script, bundles it, deploys the public API endpoints, and schedules the hourly Cron trigger sweep.

---
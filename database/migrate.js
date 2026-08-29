const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Read the .env file in be-reddit-management
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');

// Parse connection URL
let databaseUrl = '';
const lines = envContent.split('\n');
for (const line of lines) {
  if (line.includes('DATABASE_URL=')) {
    if (line.startsWith('postgresql://DATABASE_URL=')) {
      databaseUrl = line.replace('postgresql://DATABASE_URL=', 'postgresql://');
    } else {
      const match = line.match(/DATABASE_URL=["']?([^"'\s]+)["']?/);
      if (match) {
        databaseUrl = match[1];
      }
    }
  } else if (line.trim().startsWith('postgresql://')) {
    databaseUrl = line.trim();
  }
}

if (!databaseUrl) {
  console.error('Could not find DATABASE_URL in .env');
  process.exit(1);
}

console.log('Connecting to database...');
const client = new Client({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

const sql = `
CREATE TABLE IF NOT EXISTS password_resets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT REFERENCES users(email) ON DELETE CASCADE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);
CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON password_resets(expires_at);

ALTER TABLE user_tasks ADD COLUMN IF NOT EXISTS admin_note TEXT;
ALTER TABLE user_tasks ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE user_tasks DROP COLUMN IF EXISTS rejection_reason;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS original_quota INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
UPDATE tasks SET original_quota = quota WHERE original_quota IS NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id TEXT REFERENCES roles(id) DEFAULT 'basic';

DO $$ 
BEGIN 
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='user_roles') THEN 
    UPDATE users SET role_id = ur.role_id FROM user_roles ur WHERE users.id = ur.user_id; 
  END IF; 
END $$;

UPDATE users SET role_id = 'basic' WHERE role_id IS NULL;
ALTER TABLE users ALTER COLUMN role_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);
DROP TABLE IF EXISTS user_roles;
-- -------------------------------------------------------------
-- Payment info: new type and table + migrate existing paypal data
-- -------------------------------------------------------------
ALTER TABLE users DROP COLUMN IF EXISTS paypal;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_type') THEN
    CREATE TYPE payment_type AS ENUM ('paypal', 'bank', 'crypto');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS payment_info (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type payment_type NOT NULL,
  account_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Migrate any legacy paypal values from seeds if they still exist (safe no-op otherwise)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='paypal') THEN
    INSERT INTO payment_info (user_id, type, account_details, created_at, updated_at)
    SELECT id, 'paypal'::payment_type, jsonb_build_object('username', paypal), NOW(), NOW()
    FROM users WHERE paypal IS NOT NULL;
  END IF;
EXCEPTION WHEN undefined_table THEN
  -- no-op
END$$;
`;

async function run() {
  try {
    await client.connect();
    console.log('Connected. Running migration schema SQL...');
    await client.query(sql);
    console.log('Migration successful: user_roles refactored into users.role_id.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

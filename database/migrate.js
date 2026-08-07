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

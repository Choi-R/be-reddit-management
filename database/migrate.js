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
`;

async function run() {
  try {
    await client.connect();
    console.log('Connected. Running migration schema SQL...');
    await client.query(sql);
    console.log('Migration successful: password_resets table and indexes created.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

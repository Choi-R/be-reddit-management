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
-- Add is_unrestorable column to tasks table
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_unrestorable BOOLEAN DEFAULT FALSE NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_is_unrestorable ON tasks(is_unrestorable);
`;

async function run() {
  try {
    await client.connect();
    console.log('Connected. Running is_unrestorable migration SQL...');
    await client.query(sql);
    console.log('Migration successful: tasks.is_unrestorable column and index added.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

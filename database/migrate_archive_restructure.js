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
-- 1. Ensure any unrestorable tasks have deleted_at populated if not already
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'tasks' AND column_name = 'is_unrestorable'
  ) THEN
    UPDATE tasks SET deleted_at = COALESCE(deleted_at, NOW()) WHERE is_unrestorable = TRUE;
    DROP INDEX IF EXISTS idx_tasks_is_unrestorable;
    ALTER TABLE tasks DROP COLUMN is_unrestorable;
  END IF;
END $$;

-- 2. Add is_archived column if it doesn't exist
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_is_archived ON tasks(is_archived);
`;

async function run() {
  try {
    await client.connect();
    console.log('Connected. Running archive restructure migration SQL...');
    await client.query(sql);
    console.log('Migration successful: is_unrestorable removed, is_archived added with index.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

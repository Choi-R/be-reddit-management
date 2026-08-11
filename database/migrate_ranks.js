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
-- 1. Create account_ranks table
CREATE TABLE IF NOT EXISTS account_ranks (
    id TEXT PRIMARY KEY,
    rank_name TEXT NOT NULL,
    cqm_level TEXT NOT NULL,
    rank_level INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Trigger for account_ranks updated_at
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_account_ranks_updated_at') THEN
    CREATE TRIGGER update_account_ranks_updated_at BEFORE UPDATE ON account_ranks FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- 2. Seed account_ranks
INSERT INTO account_ranks (id, rank_name, cqm_level, rank_level) VALUES
('E', 'Rank E', 'Banned', 0),
('D', 'Rank D', 'Lowest', 1),
('C', 'Rank C', 'Low', 2),
('B', 'Rank B', 'Moderate', 3),
('A', 'Rank A', 'High', 4),
('S', 'Rank S', 'Highest', 5)
ON CONFLICT (id) DO UPDATE SET
  rank_name = EXCLUDED.rank_name,
  cqm_level = EXCLUDED.cqm_level,
  rank_level = EXCLUDED.rank_level;

-- 3. Add rank_id column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_id TEXT REFERENCES account_ranks(id) DEFAULT 'D';
UPDATE users SET rank_id = 'D' WHERE rank_id IS NULL;
ALTER TABLE users ALTER COLUMN rank_id SET NOT NULL;

-- 4. Clean up legacy tier roles from roles table if present
DELETE FROM roles WHERE id IN ('bronze', 'silver', 'gold');

-- 5. Add min_rank_id column to tasks table
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS min_rank_id TEXT REFERENCES account_ranks(id) DEFAULT NULL;

-- 6. Drop type_id column from tasks table if it exists
ALTER TABLE tasks DROP COLUMN IF EXISTS type_id CASCADE;

-- 7. Drop task_types table if it exists
DROP TABLE IF EXISTS task_types CASCADE;
`;

async function run() {
  try {
    await client.connect();
    console.log('Connected. Running Account Ranks migration SQL...');
    await client.query(sql);
    console.log('Migration successful: account_ranks table created, task_types removed, tasks.min_rank_id added, users.rank_id added.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

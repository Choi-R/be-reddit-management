const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');

let databaseUrl = '';
for (const line of envContent.split('\n')) {
  if (line.includes('DATABASE_URL=')) {
    if (line.startsWith('postgresql://DATABASE_URL=')) {
      databaseUrl = line.replace('postgresql://DATABASE_URL=', 'postgresql://');
    } else {
      const match = line.match(/DATABASE_URL=["']?([^"'\s]+)["']?/);
      if (match) databaseUrl = match[1];
    }
  }
}

if (!databaseUrl) {
  console.error('Could not find DATABASE_URL in .env');
  process.exit(1);
}

const client = new Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();
  console.log('Connected to DB');

  console.log('1. Creating task_assignments table if not exists...');
  await client.query(`
    CREATE TABLE IF NOT EXISTS task_assignments (
      task_id UUID REFERENCES tasks(id) ON DELETE CASCADE NOT NULL,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      PRIMARY KEY (task_id, user_id)
    );
  `);
  console.log('✓ task_assignments table verified/created');

  console.log('2. Creating trigger for task_assignments...');
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_task_assignments_updated_at'
      ) THEN
        CREATE TRIGGER update_task_assignments_updated_at 
        BEFORE UPDATE ON task_assignments 
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      END IF;
    END $$;
  `);
  console.log('✓ update_task_assignments_updated_at trigger verified');

  console.log('3. Creating indexes for task_assignments...');
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_task_assignments_task ON task_assignments(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_assignments_user ON task_assignments(user_id);
  `);
  console.log('✓ task_assignments indexes verified');

  console.log('4. Backfilling task_assignments from existing tasks.assigned_to...');
  const backfillRes = await client.query(`
    INSERT INTO task_assignments (task_id, user_id, created_at, updated_at)
    SELECT id, assigned_to, created_at, updated_at
    FROM tasks
    WHERE assigned_to IS NOT NULL
    ON CONFLICT (task_id, user_id) DO NOTHING;
  `);
  console.log(`✓ Backfilled ${backfillRes.rowCount} assignment records from existing tasks`);

  console.log('Migration completed successfully!');
  await client.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

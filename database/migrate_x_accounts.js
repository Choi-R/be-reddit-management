const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Read the .env file
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

(async () => {
  try {
    await client.connect();
    console.log('Connected to database.');

    // 1. Update platform constraint on tasks table to include 'X'
    // First, find the constraint name on the platform column
    const constraintRes = await client.query(`
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE rel.relname = 'tasks' AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%platform%';
    `);

    for (const row of constraintRes.rows) {
      console.log(`Dropping old constraint: ${row.conname}`);
      await client.query(`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS "${row.conname}"`);
    }

    await client.query(`
      ALTER TABLE tasks 
      ADD CONSTRAINT tasks_platform_check 
      CHECK (platform IN ('REDDIT', 'PRODUCTHUNT', 'X'));
    `);
    console.log('Updated tasks_platform_check to allow REDDIT, PRODUCTHUNT, X');

    // 2. Create x_accounts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS x_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        username TEXT NOT NULL,
        headline TEXT,
        bio TEXT,
        about TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `);
    console.log('Created x_accounts table');

    // 3. Create index for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_x_accounts_user_id ON x_accounts(user_id)
    `);
    console.log('Created idx_x_accounts_user_id index');

    // 4. Create trigger
    await client.query(`
      DROP TRIGGER IF EXISTS update_x_accounts_updated_at ON x_accounts;
      CREATE TRIGGER update_x_accounts_updated_at 
      BEFORE UPDATE ON x_accounts 
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `);
    console.log('Created update_x_accounts_updated_at trigger');

    await client.end();
    console.log('Migration finished successfully!');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
})();

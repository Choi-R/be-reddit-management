const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');

let databaseUrl = '';
for (const line of envContent.split('\n')) {
  if (line.startsWith('DATABASE_URL=')) {
    databaseUrl = line.split('=')[1].trim();
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
  
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_indonesian BOOLEAN DEFAULT FALSE NOT NULL;
  `);
  console.log('Successfully added is_indonesian column to users table');
  
  const res = await client.query(`
    SELECT column_name, data_type, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'is_indonesian';
  `);
  console.log('Column details:', res.rows[0]);

  await client.end();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

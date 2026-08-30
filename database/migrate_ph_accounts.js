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
  await client.connect();
  
  // Create producthunt_accounts table
  await client.query(`
    CREATE TABLE IF NOT EXISTS producthunt_accounts (
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
  console.log('Created producthunt_accounts table');

  // Create trigger
  await client.query(`
    CREATE TRIGGER update_producthunt_accounts_updated_at 
    BEFORE UPDATE ON producthunt_accounts 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
  `);
  console.log('Created update_producthunt_accounts_updated_at trigger');

  await client.end();
  console.log('Done!');
})();

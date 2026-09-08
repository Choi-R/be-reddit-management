const { Client } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function readDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const envPath = path.join(__dirname, '..', '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const match = envContent.match(/^DATABASE_URL=["']?([^"'\r\n]+)["']?$/m);
  return match ? match[1] : '';
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(password + salt, 'utf8').digest('hex');
  return `${salt}:${hash}`;
}

async function run() {
  const databaseUrl = readDatabaseUrl();
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const reddit = process.env.ADMIN_REDDIT;

  if (!databaseUrl || !email || !password || !reddit) {
    throw new Error('DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, and ADMIN_REDDIT are required.');
  }
  if (password.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters long.');
  }

  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const result = await client.query(
      `INSERT INTO users (email, password, reddit, role_id)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email`,
      [email, createPasswordHash(password), reddit]
    );

    if (result.rows.length === 0) {
      throw new Error(`An account with email "${email}" already exists; no changes were made.`);
    }

    console.log(`Created administrator account: ${result.rows[0].email}`);
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

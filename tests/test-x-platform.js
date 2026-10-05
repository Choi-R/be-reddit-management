const assert = require('assert');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Read DATABASE_URL from .env
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

// Inline extractXUsername logic to test edge cases
function extractXUsername(input) {
  if (!input) return '';
  let cleaned = input.trim();
  cleaned = cleaned.replace(/^(https?:\/\/)?(www\.)?(x\.com|twitter\.com)\//i, '');
  cleaned = cleaned.replace(/^\//, '');
  if (cleaned.startsWith('@')) {
    cleaned = cleaned.substring(1);
  }
  cleaned = cleaned.split('/')[0].split('?')[0];
  return cleaned.trim();
}

async function runCheck() {
  console.log('--- 1. Testing extractXUsername unit cases ---');
  assert.strictEqual(extractXUsername('@elonmusk'), 'elonmusk');
  assert.strictEqual(extractXUsername('elonmusk'), 'elonmusk');
  assert.strictEqual(extractXUsername('https://x.com/elonmusk'), 'elonmusk');
  assert.strictEqual(extractXUsername('https://twitter.com/elonmusk?s=20'), 'elonmusk');
  assert.strictEqual(extractXUsername('http://www.x.com/@elonmusk/status/12345'), 'elonmusk');
  console.log('✓ extractXUsername passed all cases');

  console.log('--- 2. Testing database platform constraint & x_accounts table ---');
  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  try {
    // A. Verify task insertion with platform = 'X'
    const insertTaskRes = await client.query(`
      INSERT INTO tasks (platform, target_subreddit, url, client_request, quota, original_quota, price)
      VALUES ('X', 'elonmusk', 'https://x.com/elonmusk/status/1234567890', 'Test X task', 1, 1, 2.50)
      RETURNING *;
    `);
    assert.strictEqual(insertTaskRes.rows.length, 1);
    const testTaskId = insertTaskRes.rows[0].id;
    assert.strictEqual(insertTaskRes.rows[0].platform, 'X');
    console.log('✓ Successfully inserted task with platform = X');

    // B. Clean up test task
    await client.query('DELETE FROM tasks WHERE id = $1', [testTaskId]);
    console.log('✓ Cleaned up test task');

    // C. Verify x_accounts CRUD with an existing user
    const userRes = await client.query('SELECT id FROM users LIMIT 1');
    if (userRes.rows.length > 0) {
      const testUserId = userRes.rows[0].id;
      const insertXRes = await client.query(`
        INSERT INTO x_accounts (user_id, username, headline, bio)
        VALUES ($1, 'test_x_user', 'Builder', 'Just testing')
        RETURNING *;
      `, [testUserId]);
      assert.strictEqual(insertXRes.rows.length, 1);
      const testXAccountId = insertXRes.rows[0].id;
      assert.strictEqual(insertXRes.rows[0].username, 'test_x_user');
      console.log('✓ Successfully inserted x_accounts record');

      // Update
      const updateXRes = await client.query(`
        UPDATE x_accounts SET headline = 'Updated Builder' WHERE id = $1 RETURNING headline
      `, [testXAccountId]);
      assert.strictEqual(updateXRes.rows[0].headline, 'Updated Builder');
      console.log('✓ Successfully updated x_accounts record');

      // Delete
      await client.query('DELETE FROM x_accounts WHERE id = $1', [testXAccountId]);
      console.log('✓ Cleaned up test x_accounts record');
    }

    console.log('\nALL BACKEND X-PLATFORM CHECKS PASSED SUCCESSFULLY!');
  } finally {
    await client.end();
  }
}

runCheck().catch((err) => {
  console.error('Check failed:', err);
  process.exit(1);
});

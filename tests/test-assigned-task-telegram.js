const assert = require('assert');
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

async function runCheck() {
  console.log('--- Testing Assigned Task Creation & Telegram Exclusion ---');
  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  try {
    // 1. Verify task_assignments table exists and has expected columns
    const cols = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'task_assignments'
    `);
    const colNames = cols.rows.map(r => r.column_name);
    assert(colNames.includes('task_id'), 'task_id column must exist');
    assert(colNames.includes('user_id'), 'user_id column must exist');
    console.log('✓ task_assignments table verified with columns:', colNames);

    // 2. Fetch an existing user to assign
    const userRes = await client.query('SELECT id, email, nickname FROM users LIMIT 1');
    assert(userRes.rows.length > 0, 'At least one user must exist in the database');
    const testUser = userRes.rows[0];
    console.log(`✓ Using test user: ${testUser.email} (${testUser.id})`);

    // 3. Insert an X task assigned to this user
    const insertRes = await client.query(`
      INSERT INTO tasks (platform, target_subreddit, url, client_request, quota, original_quota, assigned_to, price)
      VALUES ('X', 'test_x_account', 'https://x.com/test_x_account/status/1234567890', 'Please like and comment', 1, 1, $1, 3.00)
      RETURNING *;
    `, [testUser.id]);

    assert.strictEqual(insertRes.rows.length, 1);
    const createdTask = insertRes.rows[0];
    assert.strictEqual(createdTask.platform, 'X');
    assert.strictEqual(createdTask.target_subreddit, 'test_x_account');
    assert.strictEqual(createdTask.assigned_to, testUser.id);
    console.log('✓ Task inserted with platform = X and assigned_to correctly set');

    // 4. Insert assignment into task_assignments
    await client.query(`
      INSERT INTO task_assignments (task_id, user_id, created_at, updated_at)
      VALUES ($1, $2, NOW(), NOW())
      ON CONFLICT (task_id, user_id) DO NOTHING;
    `, [createdTask.id, testUser.id]);

    const assignmentRes = await client.query(`
      SELECT * FROM task_assignments WHERE task_id = $1 AND user_id = $2;
    `, [createdTask.id, testUser.id]);
    assert.strictEqual(assignmentRes.rows.length, 1);
    console.log('✓ task_assignments record verified for task and user');

    // 5. Test exclusion query in checkAndNotifyTelegramTaskCreated
    const previousTaskRes = await client.query(`
      SELECT created_at FROM tasks WHERE id != ALL($1) ORDER BY created_at DESC LIMIT 1;
    `, [[createdTask.id]]);
    assert(previousTaskRes.rows.length > 0, 'Previous task should be found when excluding newly created task');
    assert.notStrictEqual(new Date(previousTaskRes.rows[0].created_at).getTime(), new Date(createdTask.created_at).getTime(), 'Excluded task must not match previous task created_at');
    console.log('✓ Cooldown exclusion query correctly ignores the new task');

    // 6. Test admin task query aggregation for assigned_to_email
    const adminQueryRes = await client.query(`
      SELECT t.id,
             COALESCE((SELECT string_agg(u2.email, ', ') FROM task_assignments ta JOIN users u2 ON ta.user_id = u2.id WHERE ta.task_id = t.id), u.email) as assigned_to_email
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.id = $1;
    `, [createdTask.id]);
    assert.strictEqual(adminQueryRes.rows[0].assigned_to_email, testUser.email);
    console.log('✓ Admin tasks query correctly aggregates assigned_to_email:', adminQueryRes.rows[0].assigned_to_email);

    // 7. Cleanup
    await client.query('DELETE FROM task_assignments WHERE task_id = $1', [createdTask.id]);
    await client.query('DELETE FROM tasks WHERE id = $1', [createdTask.id]);
    console.log('✓ Cleaned up test records');

    console.log('\nALL ASSIGNED TASK & TELEGRAM VERIFICATION CHECKS PASSED!');
  } finally {
    await client.end();
  }
}

runCheck().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});

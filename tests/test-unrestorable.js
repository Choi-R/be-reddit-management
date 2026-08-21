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

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:8787';

async function apiRequest(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function runTests() {
  console.log('--- STARTING UNRESTORABLE / TRASH TASKS TEST SUITE ---\n');

  // 1. Admin Login
  console.log('1. Admin logging in...');
  const loginRes = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'admin@redditcrm.com',
      password: 'AdminCRM2026!',
    }),
  });

  if (loginRes.status !== 200 || !loginRes.data.token) {
    throw new Error(`Admin login failed: ${JSON.stringify(loginRes.data)}`);
  }
  const adminToken = loginRes.data.token;
  console.log('✅ Admin authenticated.\n');

  // 2. Create a test task
  console.log('2. Creating new test task...');
  const createRes = await apiRequest('/api/admin/tasks', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      url: 'https://reddit.com/r/test_unrestorable/comments/xyz123',
      clientRequest: 'Test unrestorable trash lifecycle',
      quota: 3,
      price: 15.00,
      minRankId: 'D'
    }),
  });

  if (createRes.status !== 200 || !createRes.data.task) {
    throw new Error(`Create task failed: ${JSON.stringify(createRes.data)}`);
  }
  const taskId = createRes.data.task.id;
  console.log(`✅ Created Task ID: ${taskId}\n`);

  // 3. Check GET /admin/tasks -> should be in `tasks` (activeTasks)
  console.log('3. Checking GET /admin/tasks for active task...');
  let tasksRes = await apiRequest('/api/admin/tasks', {
    method: 'GET',
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  let activeMatch = tasksRes.data.tasks.find(t => t.id === taskId);
  let archiveMatch = tasksRes.data.archivedTasks.find(t => t.id === taskId);
  let unrestorableMatch = tasksRes.data.unrestorableTasks.find(t => t.id === taskId);

  if (!activeMatch || archiveMatch || unrestorableMatch) {
    throw new Error('Task should be in active tasks list only');
  }
  console.log('✅ Task is in active tasks.\n');

  // 4. Soft delete the active task -> Should move to `archivedTasks`
  console.log('4. Deleting active task (first delete -> moves to Archive)...');
  const del1Res = await apiRequest(`/api/admin/tasks/${taskId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  if (del1Res.status !== 200 || !del1Res.data.success) {
    throw new Error(`First delete failed: ${JSON.stringify(del1Res.data)}`);
  }
  console.log(`✅ ${del1Res.data.message}`);

  tasksRes = await apiRequest('/api/admin/tasks', {
    method: 'GET',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  activeMatch = tasksRes.data.tasks.find(t => t.id === taskId);
  archiveMatch = tasksRes.data.archivedTasks.find(t => t.id === taskId);
  unrestorableMatch = tasksRes.data.unrestorableTasks.find(t => t.id === taskId);

  if (activeMatch || !archiveMatch || unrestorableMatch) {
    throw new Error('Task should be in archived tasks list only');
  }
  console.log(`✅ Task successfully moved to archivedTasks (Reason: ${archiveMatch.archive_reason}).\n`);

  // 5. Delete task from Archive -> Should move to `unrestorableTasks`
  console.log('5. Deleting archived task (second delete -> moves to Unrestorable Tasks)...');
  const del2Res = await apiRequest(`/api/admin/tasks/${taskId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  if (del2Res.status !== 200 || !del2Res.data.success) {
    throw new Error(`Second delete failed: ${JSON.stringify(del2Res.data)}`);
  }
  console.log(`✅ ${del2Res.data.message}`);

  tasksRes = await apiRequest('/api/admin/tasks', {
    method: 'GET',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  activeMatch = tasksRes.data.tasks.find(t => t.id === taskId);
  archiveMatch = tasksRes.data.archivedTasks.find(t => t.id === taskId);
  unrestorableMatch = tasksRes.data.unrestorableTasks.find(t => t.id === taskId);

  if (activeMatch || archiveMatch || !unrestorableMatch) {
    throw new Error('Task should now be in unrestorableTasks list only and completely removed from archivedTasks');
  }
  console.log(`✅ Task successfully moved to unrestorableTasks (Archive list is clean!).\n`);

  // 6. Attempt to restore the unrestorable task -> Should fail with CANNOT_RESTORE
  console.log('6. Attempting to restore unrestorable task...');
  const restoreRes = await apiRequest(`/api/admin/tasks/${taskId}/restore`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  if (restoreRes.status !== 400 || restoreRes.data.code !== 'CANNOT_RESTORE') {
    throw new Error(`Restore should have been rejected with CANNOT_RESTORE, got: ${JSON.stringify(restoreRes.data)}`);
  }
  console.log(`✅ Restore blocked correctly: ${restoreRes.data.error}\n`);

  // Clean up test task
  const pool = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await pool.connect();
  await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
  await pool.end();
  console.log('✅ Cleaned up test task from database.');

  console.log('\n🎉 ALL UNRESTORABLE TASK LIFECYCLE TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

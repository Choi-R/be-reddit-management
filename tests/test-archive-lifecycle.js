const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Read the .env file in be-reddit-management
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');

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

const client = new Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

function request(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function runTest() {
  console.log('🧪 Starting Archive & Soft Delete Lifecycle Automated Tests...');
  await client.connect();

  try {
    // 1. Authenticate as Admin
    console.log('\n--- Step 1: Login as Admin ---');
    const loginRes = await request(
      {
        hostname: 'localhost',
        port: 8787,
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      { email: 'admin@redditcrm.com', password: 'AdminCRM2026!' }
    );

    if (loginRes.status !== 200 || !loginRes.data.token) {
      throw new Error(`Admin login failed: ${JSON.stringify(loginRes.data)}`);
    }
    const token = loginRes.data.token;
    console.log('✅ Admin login successful');

    const adminHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    // 2. Create a fresh test task
    console.log('\n--- Step 2: Create Test Task ---');
    const createRes = await request(
      {
        hostname: 'localhost',
        port: 8787,
        path: '/api/admin/tasks',
        method: 'POST',
        headers: adminHeaders,
      },
      {
        subreddit: 'lifecycle_test',
        url: 'https://reddit.com/r/lifecycle_test/comments/12345',
        clientRequest: 'Test lifecycle restructurization',
        quota: 2,
        price: 5.0,
      }
    );
    if (createRes.status !== 201 && createRes.status !== 200) {
      throw new Error(`Task creation failed: ${JSON.stringify(createRes.data)}`);
    }
    const testTaskId = createRes.data.task.id;
    console.log(`✅ Created Task: ${testTaskId}`);

    // 3. Verify task is in Active tasks
    console.log('\n--- Step 3: Verify Task is in Active Tasks ---');
    let listRes = await request({
      hostname: 'localhost',
      port: 8787,
      path: '/api/admin/tasks',
      method: 'GET',
      headers: adminHeaders,
    });
    let foundInActive = listRes.data.tasks.find((t) => t.id === testTaskId);
    let foundInArchived = listRes.data.archivedTasks.find((t) => t.id === testTaskId);
    let foundInCompleted = listRes.data.completedTasks.find((t) => t.id === testTaskId);
    let foundInDeleted = listRes.data.deletedTasks.find((t) => t.id === testTaskId);

    if (!foundInActive || foundInArchived || foundInCompleted || foundInDeleted) {
      throw new Error('Task should only be in Active tasks bucket');
    }
    console.log('✅ Verified: Task is in Active bucket');

    // 4. Archive task explicitly
    console.log('\n--- Step 4: Archive Task Explicitly ---');
    const archiveRes = await request(
      {
        hostname: 'localhost',
        port: 8787,
        path: `/api/admin/tasks/${testTaskId}/archive`,
        method: 'POST',
        headers: adminHeaders,
      },
      {}
    );
    if (archiveRes.status !== 200 || !archiveRes.data.success) {
      throw new Error(`Archive failed: ${JSON.stringify(archiveRes.data)}`);
    }
    console.log('✅ Archive endpoint returned success');

    // 5. Verify task is in Archived bucket
    console.log('\n--- Step 5: Verify Task is in Archived Bucket ---');
    listRes = await request({
      hostname: 'localhost',
      port: 8787,
      path: '/api/admin/tasks',
      method: 'GET',
      headers: adminHeaders,
    });
    foundInActive = listRes.data.tasks.find((t) => t.id === testTaskId);
    foundInArchived = listRes.data.archivedTasks.find((t) => t.id === testTaskId);
    foundInCompleted = listRes.data.completedTasks.find((t) => t.id === testTaskId);
    foundInDeleted = listRes.data.deletedTasks.find((t) => t.id === testTaskId);

    if (foundInActive || !foundInArchived || foundInCompleted || foundInDeleted) {
      throw new Error('Task should only be in Archived bucket');
    }
    console.log('✅ Verified: Task moved to Archived bucket (is_archived=true)');

    // 6. Restore task from Archive
    console.log('\n--- Step 6: Restore Task from Archive ---');
    const restoreRes = await request(
      {
        hostname: 'localhost',
        port: 8787,
        path: `/api/admin/tasks/${testTaskId}/restore`,
        method: 'POST',
        headers: adminHeaders,
      },
      {}
    );
    if (restoreRes.status !== 200 || !restoreRes.data.success) {
      throw new Error(`Restore failed: ${JSON.stringify(restoreRes.data)}`);
    }
    console.log('✅ Restore endpoint returned success');

    // 7. Verify task returned to Active
    console.log('\n--- Step 7: Verify Task Returned to Active Bucket ---');
    listRes = await request({
      hostname: 'localhost',
      port: 8787,
      path: '/api/admin/tasks',
      method: 'GET',
      headers: adminHeaders,
    });
    foundInActive = listRes.data.tasks.find((t) => t.id === testTaskId);
    foundInArchived = listRes.data.archivedTasks.find((t) => t.id === testTaskId);
    if (!foundInActive || foundInArchived) {
      throw new Error('Task should have returned to Active bucket');
    }
    console.log('✅ Verified: Task restored to Active bucket');

    // 8. Soft-delete the task
    console.log('\n--- Step 8: Soft-delete Task ---');
    const deleteRes = await request({
      hostname: 'localhost',
      port: 8787,
      path: `/api/admin/tasks/${testTaskId}`,
      method: 'DELETE',
      headers: adminHeaders,
    });
    if (deleteRes.status !== 200 || !deleteRes.data.success) {
      throw new Error(`Delete failed: ${JSON.stringify(deleteRes.data)}`);
    }
    console.log('✅ Delete endpoint returned success');

    // 9. Verify task is in Deleted bucket
    console.log('\n--- Step 9: Verify Task is in Deleted Bucket ---');
    listRes = await request({
      hostname: 'localhost',
      port: 8787,
      path: '/api/admin/tasks',
      method: 'GET',
      headers: adminHeaders,
    });
    foundInActive = listRes.data.tasks.find((t) => t.id === testTaskId);
    foundInArchived = listRes.data.archivedTasks.find((t) => t.id === testTaskId);
    foundInCompleted = listRes.data.completedTasks.find((t) => t.id === testTaskId);
    foundInDeleted = listRes.data.deletedTasks.find((t) => t.id === testTaskId);

    if (foundInActive || foundInArchived || foundInCompleted || !foundInDeleted) {
      throw new Error('Task should only be in Deleted bucket');
    }
    console.log('✅ Verified: Task is in Deleted bucket (deleted_at IS NOT NULL)');

    // 10. Attempt to restore deleted task (Must fail with CANNOT_RESTORE)
    console.log('\n--- Step 10: Verify Deleted Task Cannot Be Restored ---');
    const invalidRestore = await request(
      {
        hostname: 'localhost',
        port: 8787,
        path: `/api/admin/tasks/${testTaskId}/restore`,
        method: 'POST',
        headers: adminHeaders,
      },
      {}
    );
    if (invalidRestore.status !== 400 || invalidRestore.data.code !== 'CANNOT_RESTORE') {
      throw new Error(`Expected HTTP 400 CANNOT_RESTORE, received: ${JSON.stringify(invalidRestore)}`);
    }
    console.log('✅ Verified: Deleted task cannot be restored (rejected with CANNOT_RESTORE)');

    // Cleanup test task directly from DB
    await client.query('DELETE FROM tasks WHERE id = $1', [testTaskId]);
    console.log('\n🎉 ALL LIFECYCLE TESTS PASSED PERFECTLY!\n');
  } catch (err) {
    console.error('\n❌ Test failure:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runTest();

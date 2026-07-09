// E2E Integration Test Script for Reddit CRM Backend
// Execute locally with: node test-api.js [API_BASE_URL]
// Default base URL: http://localhost:8787

const baseUrl = process.argv[2] || 'http://localhost:8787';
console.log(`Starting E2E API Verification against: ${baseUrl}\n`);

// Global variables to store session tokens and IDs
let adminToken = '';
let basicToken = '';
let basicUserId = '';
let taskId = '';
let bookingId = '';

// Helper to make API requests
async function apiRequest(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    data = text;
  }

  return { status: response.status, data };
}

// Main test flow
async function runTests() {
  try {
    // -------------------------------------------------------------
    // Step 1: Admin Login
    // -------------------------------------------------------------
    console.log('Step 1: Authenticating as default Admin...');
    const adminLoginRes = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@redditcrm.com',
        password: 'AdminCRM2026!',
      }),
    });

    if (adminLoginRes.status !== 200) {
      throw new Error(`Admin login failed: ${JSON.stringify(adminLoginRes.data)}`);
    }

    adminToken = adminLoginRes.data.token;
    console.log('✅ Admin authenticated successfully.\n');

    // -------------------------------------------------------------
    // Step 2: Create a Basic User
    // -------------------------------------------------------------
    const testEmail = `user_${Date.now()}@redditcrm.com`;
    console.log(`Step 2: Creating a new Basic User account (${testEmail})...`);
    const createUserRes = await apiRequest('/api/admin/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        email: testEmail,
        password: 'UserPass2026!',
        paypal: 'test_paypal@paypal.com',
        reddit: 'reddit_test_user',
      }),
    });

    if (createUserRes.status !== 200) {
      throw new Error(`Failed to create basic user: ${JSON.stringify(createUserRes.data)}`);
    }

    basicUserId = createUserRes.data.user.id;
    console.log('✅ Basic User account created successfully.\n');

    // -------------------------------------------------------------
    // Step 3: Authenticate as the New Basic User
    // -------------------------------------------------------------
    console.log('Step 3: Authenticating as the newly created Basic User...');
    const userLoginRes = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: testEmail,
        password: 'UserPass2026!',
      }),
    });

    if (userLoginRes.status !== 200) {
      throw new Error(`Basic user authentication failed: ${JSON.stringify(userLoginRes.data)}`);
    }

    basicToken = userLoginRes.data.token;
    console.log('✅ Basic User authenticated successfully.\n');

    // -------------------------------------------------------------
    // Step 4: Admin Creates a Task
    // -------------------------------------------------------------
    console.log('Step 4: Admin creating a new commenting task...');
    const createTaskRes = await apiRequest('/api/admin/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        subreddit: 'reactjs',
        postUrl: 'https://reddit.com/r/reactjs/comments/example',
        clientRequest: 'Leave a detailed review of the new Vite setup features.',
        quota: 2,
        price: 7.50,
        typeId: 'normal',
      }),
    });

    if (createTaskRes.status !== 200) {
      throw new Error(`Failed to create task: ${JSON.stringify(createTaskRes.data)}`);
    }

    taskId = createTaskRes.data.task.id;
    console.log(`✅ Task created successfully. (ID: ${taskId}, Quota: 2, Price: $7.50)\n`);

    // -------------------------------------------------------------
    // Step 5: Basic User views Available Tasks
    // -------------------------------------------------------------
    console.log('Step 5: Basic user listing available tasks...');
    const getAvailableRes = await apiRequest('/api/tasks/available', {
      method: 'GET',
      headers: { Authorization: `Bearer ${basicToken}` },
    });

    if (getAvailableRes.status !== 200) {
      throw new Error(`Failed to retrieve available tasks: ${JSON.stringify(getAvailableRes.data)}`);
    }

    const foundTask = getAvailableRes.data.available.find(t => t.id === taskId);
    if (!foundTask) {
      throw new Error('Task created by Admin is not showing up in Basic User\'s available tasks.');
    }
    console.log('✅ Created task found in available tasks list.\n');

    // -------------------------------------------------------------
    // Step 6: Basic User books the Task
    // -------------------------------------------------------------
    console.log('Step 6: Basic user booking the task...');
    const bookRes = await apiRequest('/api/tasks/book', {
      method: 'POST',
      headers: { Authorization: `Bearer ${basicToken}` },
      body: JSON.stringify({ taskId }),
    });

    if (bookRes.status !== 200) {
      throw new Error(`Failed to book task: ${JSON.stringify(bookRes.data)}`);
    }

    bookingId = bookRes.data.booking.id;
    console.log(`✅ Task booked successfully. Booking status is: ${bookRes.data.booking.status_id}\n`);

    // -------------------------------------------------------------
    // Step 7: Double-booking Prevention Check
    // -------------------------------------------------------------
    console.log('Step 7: Verifying double-booking lock rules...');
    const doubleBookRes = await apiRequest('/api/tasks/book', {
      method: 'POST',
      headers: { Authorization: `Bearer ${basicToken}` },
      body: JSON.stringify({ taskId }),
    });

    if (doubleBookRes.status === 200) {
      throw new Error('Lock failure: Basic user was allowed to double-book tasks.');
    }
    console.log('✅ Double-booking rejected correctly. Server returned:', doubleBookRes.data.error, '\n');

    // -------------------------------------------------------------
    // Step 8: Basic User Submits Completed Task URL
    // -------------------------------------------------------------
    console.log('Step 8: Basic user submitting Reddit reply URL...');
    const submitRes = await apiRequest('/api/tasks/submit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${basicToken}` },
      body: JSON.stringify({
        taskId,
        replyUrl: 'https://reddit.com/r/reactjs/comments/example/reply/1234',
        note: 'Completed task with detailed Vite review.',
      }),
    });

    if (submitRes.status !== 200) {
      throw new Error(`Failed to submit task: ${JSON.stringify(submitRes.data)}`);
    }
    console.log(`✅ Task reply submitted successfully. Status updated to: ${submitRes.data.booking.status_id}\n`);

    // -------------------------------------------------------------
    // Step 9: Admin Reviews Task (Approve)
    // -------------------------------------------------------------
    console.log('Step 9: Admin reviewing and approving submission...');
    const reviewRes = await apiRequest('/api/admin/tasks/review', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        bookingId,
        statusId: 'success',
        note: 'Approved. Great feedback.',
      }),
    });

    if (reviewRes.status !== 200) {
      throw new Error(`Failed to approve task: ${JSON.stringify(reviewRes.data)}`);
    }
    console.log(`✅ Submission approved. Status changed to: ${reviewRes.data.booking.status_id}\n`);

    // -------------------------------------------------------------
    // Step 10: Basic User Checks Earnings
    // -------------------------------------------------------------
    console.log('Step 10: Verifying basic user earnings dashboard...');
    const earningsRes = await apiRequest('/api/tasks/earnings', {
      method: 'GET',
      headers: { Authorization: `Bearer ${basicToken}` },
    });

    if (earningsRes.status !== 200) {
      throw new Error(`Failed to check earnings: ${JSON.stringify(earningsRes.data)}`);
    }

    const { paidBalance, pendingBalance } = earningsRes.data;
    console.log(`✅ Balances - Paid: $${paidBalance}, Pending: $${pendingBalance}`);
    if (pendingBalance !== 7.50 || paidBalance !== 0) {
      throw new Error(`Earning sums are incorrect. Expected Pending: $7.50, Paid: $0. Got Pending: $${pendingBalance}, Paid: $${paidBalance}`);
    }
    console.log('✅ Earnings balance calculations match expected values.\n');

    // -------------------------------------------------------------
    // Step 11: Admin Records Payout
    // -------------------------------------------------------------
    console.log('Step 11: Admin marking user payouts as Paid...');
    const payoutRes = await apiRequest('/api/admin/payouts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ userId: basicUserId }),
    });

    if (payoutRes.status !== 200) {
      throw new Error(`Failed to record payout: ${JSON.stringify(payoutRes.data)}`);
    }
    console.log(`✅ Payout status recorded. Server message: ${payoutRes.data.message}\n`);

    // -------------------------------------------------------------
    // Step 12: Verify Earnings Balance Resets to 0
    // -------------------------------------------------------------
    console.log('Step 12: Re-verifying basic user earnings balances post-payout...');
    const postPayoutRes = await apiRequest('/api/tasks/earnings', {
      method: 'GET',
      headers: { Authorization: `Bearer ${basicToken}` },
    });

    const postBalances = postPayoutRes.data;
    console.log(`✅ Post-Payout Balances - Paid: $${postBalances.paidBalance}, Pending: $${postBalances.pendingBalance}`);
    if (postBalances.pendingBalance !== 0 || postBalances.paidBalance !== 7.50) {
      throw new Error(`Payout sums are incorrect. Expected Pending: $0, Paid: $7.50. Got Pending: $${postBalances.pendingBalance}, Paid: $${postBalances.paidBalance}`);
    }
    console.log('✅ Pending balance reset to $0 and Paid balance correctly aggregated.\n');

    console.log('🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY! The backend is 100% functional.');
  } catch (error) {
    console.error('❌ Integration test failed with error:', error.message);
    process.exit(1);
  }
}

runTests();

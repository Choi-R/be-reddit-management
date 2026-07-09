import { Hono } from 'hono';
import { getDbPool, withTransaction } from '../db/connection';
import { authMiddleware } from '../middleware/auth';
import { createPasswordHash } from '../utils/crypto';
import { Env, Variables } from '../types';

const admin = new Hono<{ Bindings: Env; Variables: Variables }>();

// All routes in this module require either 'admin' or 'choi' roles
admin.use('/*', authMiddleware(['admin', 'choi']));

// 1. Create a Basic User account
admin.post('/users', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.email || !body.password || !body.paypal || !body.reddit) {
      return c.json({ error: 'Email, password, paypal address, and reddit username are required' }, 400);
    }

    const { email, password, paypal, reddit } = body;
    const pool = getDbPool(c.env.DATABASE_URL);

    // Check if user already exists
    const userCheck = await pool.query('SELECT 1 FROM users WHERE email = $1 LIMIT 1', [email]);
    if (userCheck.rows.length > 0) {
      return c.json({ error: 'User with this email already exists' }, 400);
    }

    // Hash the password with WebCrypto (salt:hash formatting)
    const securePassword = await createPasswordHash(password);

    // Save user and assign 'basic' role within a transaction
    const newUser = await withTransaction(pool, async (client) => {
      const userInsert = await client.query(
        `INSERT INTO users (email, password, paypal, reddit, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id, email, paypal, reddit, created_at`,
        [email, securePassword, paypal, reddit]
      );
      
      const createdUser = userInsert.rows[0];

      await client.query(
        `INSERT INTO user_roles (user_id, role_id, created_at, updated_at)
         VALUES ($1, 'basic', NOW(), NOW())`,
        [createdUser.id]
      );

      return createdUser;
    });

    return c.json({ success: true, user: newUser });
  } catch (error: any) {
    console.error('Admin create user error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// 2. Fetch all Basic users with payout metrics
admin.get('/users', async (c) => {
  try {
    const pool = getDbPool(c.env.DATABASE_URL);

    const usersList = await pool.query(
      `SELECT u.id, u.email, u.paypal, u.reddit, u.created_at,
              COALESCE(
                (SELECT SUM(t.price) 
                 FROM user_tasks ut 
                 JOIN tasks t ON ut.task_id = t.id 
                 WHERE ut.user_id = u.id AND ut.status_id = 'success'), 
                0.00
              ) as pending_balance,
              COALESCE(
                (SELECT SUM(t.price) 
                 FROM user_tasks ut 
                 JOIN tasks t ON ut.task_id = t.id 
                 WHERE ut.user_id = u.id AND ut.status_id = 'paid'), 
                0.00
              ) as paid_balance
       FROM users u
       WHERE EXISTS (
         SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'basic'
       )
       ORDER BY u.email ASC`
    );

    const formattedUsers = usersList.rows.map((row: any) => ({
      id: row.id,
      email: row.email,
      paypal: row.paypal,
      reddit: row.reddit,
      createdAt: row.created_at,
      pendingBalance: parseFloat(row.pending_balance),
      paidBalance: parseFloat(row.paid_balance)
    }));

    return c.json({ users: formattedUsers });
  } catch (error: any) {
    console.error('Admin fetch users error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// 3. Create a new Task configuration
admin.post('/tasks', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.subreddit || !body.clientRequest || body.quota === undefined || !body.price || !body.typeId) {
      return c.json({ error: 'Subreddit, clientRequest, quota, price, and typeId are required' }, 400);
    }

    const { subreddit, postUrl, clientRequest, quota, assignedTo, price, deadline, typeId } = body;
    const pool = getDbPool(c.env.DATABASE_URL);

    // Verify assignedTo user exists if provided
    if (assignedTo) {
      const userCheck = await pool.query('SELECT 1 FROM users WHERE id = $1 LIMIT 1', [assignedTo]);
      if (userCheck.rows.length === 0) {
        return c.json({ error: 'Assigned user does not exist' }, 400);
      }
    }

    // Verify task type exists
    const typeCheck = await pool.query('SELECT 1 FROM task_types WHERE id = $1 LIMIT 1', [typeId]);
    if (typeCheck.rows.length === 0) {
      return c.json({ error: 'Invalid task type ID' }, 400);
    }

    const result = await pool.query(
      `INSERT INTO tasks (subreddit, post_url, client_request, quota, assigned_to, price, deadline, type_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       RETURNING *`,
      [subreddit, postUrl || null, clientRequest, quota, assignedTo || null, price, deadline || null, typeId]
    );

    return c.json({ success: true, task: result.rows[0] });
  } catch (error: any) {
    console.error('Admin create task error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// 4. Retrieve all Tasks with status metrics
admin.get('/tasks', async (c) => {
  try {
    const pool = getDbPool(c.env.DATABASE_URL);

    const tasksList = await pool.query(
      `SELECT t.id, t.subreddit, t.post_url, t.client_request, t.quota, t.price, t.deadline, t.type_id, tt.type_name,
              u.email as assigned_to_email,
              (SELECT COUNT(*)::int FROM user_tasks ut WHERE ut.task_id = t.id AND ut.status_id = 'incomplete') as count_incomplete,
              (SELECT COUNT(*)::int FROM user_tasks ut WHERE ut.task_id = t.id AND ut.status_id = 'pending') as count_pending,
              (SELECT COUNT(*)::int FROM user_tasks ut WHERE ut.task_id = t.id AND ut.status_id = 'success') as count_success,
              (SELECT COUNT(*)::int FROM user_tasks ut WHERE ut.task_id = t.id AND ut.status_id = 'paid') as count_paid,
              (SELECT COUNT(*)::int FROM user_tasks ut WHERE ut.task_id = t.id AND ut.status_id = 'failed') as count_failed
       FROM tasks t
       JOIN task_types tt ON t.type_id = tt.id
       LEFT JOIN users u ON t.assigned_to = u.id
       ORDER BY t.created_at DESC`
    );

    return c.json({ tasks: tasksList.rows });
  } catch (error: any) {
    console.error('Admin fetch tasks error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// 5. Review a user task submission (Pending -> Success or Failed)
admin.post('/tasks/review', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.bookingId || !body.statusId) {
      return c.json({ error: 'Booking ID (bookingId) and Status (statusId: success/failed) are required' }, 400);
    }

    const { bookingId, statusId, note } = body;
    if (statusId !== 'success' && statusId !== 'failed') {
      return c.json({ error: 'Status must be either "success" or "failed"' }, 400);
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    // Update status if it's currently pending
    const result = await pool.query(
      `UPDATE user_tasks 
       SET status_id = $1, note = COALESCE($2, note), updated_at = NOW()
       WHERE id = $3 AND status_id = 'pending'
       RETURNING *`,
      [statusId, note || null, bookingId]
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'No pending task submission found matching this ID' }, 400);
    }

    return c.json({ success: true, booking: result.rows[0] });
  } catch (error: any) {
    console.error('Admin review submission error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// 6. Record PayPal payouts (Mark all accumulated 'success' tasks of a user as 'paid')
admin.post('/payouts', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.userId) {
      return c.json({ error: 'User ID (userId) is required' }, 400);
    }

    const { userId } = body;
    const pool = getDbPool(c.env.DATABASE_URL);

    const updateInfo = await withTransaction(pool, async (client) => {
      // Check if user has any pending success bookings to pay
      const checkRes = await client.query(
        `SELECT 1 FROM user_tasks WHERE user_id = $1 AND status_id = 'success' LIMIT 1`,
        [userId]
      );
      if (checkRes.rows.length === 0) {
        throw new Error('NO_PENDING_EARNINGS: User has no pending success tasks to pay.');
      }

      // Update success tasks to paid
      const updateRes = await client.query(
        `UPDATE user_tasks 
         SET status_id = 'paid', updated_at = NOW()
         WHERE user_id = $1 AND status_id = 'success'
         RETURNING id`,
        [userId]
      );

      return { count: updateRes.rows.length };
    });

    return c.json({ success: true, message: `Successfully marked ${updateInfo.count} tasks as Paid.`, count: updateInfo.count });
  } catch (error: any) {
    const msg = error.message || '';
    if (msg.startsWith('NO_PENDING_EARNINGS')) {
      const [_, desc] = msg.split(': ');
      return c.json({ error: desc }, 400);
    }
    console.error('Admin record payouts transaction error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

export default admin;

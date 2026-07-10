import { Hono } from 'hono';
import { getDbPool, withTransaction } from '../db/connection';
import { authMiddleware } from '../middleware/auth';
import { createPasswordHash } from '../utils/crypto';
import { BusinessError, handleRouteError } from '../utils/errors';
import { Env, Variables } from '../types';

const admin = new Hono<{ Bindings: Env; Variables: Variables }>();

// All routes in this module require either 'admin' or 'choi' roles
admin.use('/*', authMiddleware(['admin', 'choi']));

// Input validation helpers
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email: string): void {
  if (typeof email !== 'string' || !EMAIL_REGEX.test(email) || email.length > 254) {
    throw new BusinessError('INVALID_INPUT', 'A valid email address is required (max 254 characters)');
  }
}

function validateStringField(value: unknown, name: string, maxLength = 1000): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BusinessError('MISSING_FIELD', `${name} is required`);
  }
  if (value.length > maxLength) {
    throw new BusinessError('INVALID_INPUT', `${name} is too long (max ${maxLength} characters)`);
  }
}

// 1. Create a Basic User account
admin.post('/users', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.email || !body.password || !body.paypal || !body.reddit) {
      throw new BusinessError('MISSING_FIELD', 'Email, password, paypal address, and reddit username are required');
    }

    const { email, password, paypal, reddit } = body;

    // Validate inputs
    validateEmail(email);
    validateStringField(password, 'Password', 128);
    if (password.length < 8) {
      throw new BusinessError('INVALID_INPUT', 'Password must be at least 8 characters');
    }
    validateEmail(paypal);
    validateStringField(reddit, 'Reddit username', 100);

    const pool = getDbPool(c.env.DATABASE_URL);

    // Check if user already exists
    const userCheck = await pool.query('SELECT 1 FROM users WHERE email = $1 LIMIT 1', [email]);
    if (userCheck.rows.length > 0) {
      throw new BusinessError('DUPLICATE', 'User with this email already exists');
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
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin create user error');
    return c.json(body, status);
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
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin fetch users error');
    return c.json(body, status);
  }
});

// Helper to resolve user ID from email, reddit username, or UUID string
async function resolveUserId(pool: any, identifier: string | null | undefined): Promise<string | null> {
  if (!identifier || identifier.trim() === '') {
    return null;
  }

  const cleanVal = identifier.trim();
  // Strip u/ or /u/ prefix from reddit usernames
  const strippedReddit = cleanVal.replace(/^\/?u\//i, '');

  const userRes = await pool.query(
    `SELECT id FROM users 
     WHERE email = $1 
        OR reddit = $1 
        OR reddit = $2
        OR id::text = $1 
     LIMIT 1`,
    [cleanVal, strippedReddit]
  );

  if (userRes.rows.length === 0) {
    throw new BusinessError('NOT_FOUND', `Assigned user with email, reddit username, or UUID "${identifier}" not found`);
  }

  return userRes.rows[0].id;
}

// 3. Create a new Task configuration
admin.post('/tasks', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.url || !body.clientRequest || body.quota === undefined || !body.price || !body.typeId) {
      throw new BusinessError('MISSING_FIELD', 'URL, clientRequest, quota, price, and typeId are required');
    }

    const { subreddit, url, clientRequest, quota, assignedTo, price, deadline, typeId } = body;

    // Validate inputs
    if (subreddit) {
      validateStringField(subreddit, 'Subreddit', 200);
    }
    validateStringField(url, 'Reddit URL', 2000);
    validateStringField(clientRequest, 'Client request', 5000);
    validateStringField(typeId, 'Type ID', 50);

    if (typeof quota !== 'number' || !Number.isInteger(quota) || quota < 1) {
      throw new BusinessError('INVALID_INPUT', 'Quota must be a positive integer');
    }
    if (typeof price !== 'number' || price <= 0) {
      throw new BusinessError('INVALID_INPUT', 'Price must be a positive number');
    }

    try { 
      new URL(url); 
    } catch {
      throw new BusinessError('INVALID_INPUT', 'Reddit URL must be a valid URL');
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    // Resolve assignedTo user ID from email or reddit name
    const resolvedAssignedTo = await resolveUserId(pool, assignedTo);

    // Verify task type exists
    const typeCheck = await pool.query('SELECT 1 FROM task_types WHERE id = $1 LIMIT 1', [typeId]);
    if (typeCheck.rows.length === 0) {
      throw new BusinessError('INVALID_INPUT', 'Invalid task type ID');
    }

    const result = await pool.query(
      `INSERT INTO tasks (subreddit, url, client_request, quota, assigned_to, price, deadline, type_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       RETURNING *`,
      [subreddit || null, url, clientRequest, quota, resolvedAssignedTo, price, deadline || null, typeId]
    );

    return c.json({ success: true, task: result.rows[0] });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin create task error');
    return c.json(body, status);
  }
});

// 4. Retrieve all Tasks with status metrics
admin.get('/tasks', async (c) => {
  try {
    const pool = getDbPool(c.env.DATABASE_URL);

    const tasksList = await pool.query(
      `SELECT t.id, t.subreddit, t.url, t.client_request, t.quota, t.price, t.deadline, t.type_id, tt.type_name,
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
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin fetch tasks error');
    return c.json(body, status);
  }
});

// 4a. Update a Task configuration
admin.put('/tasks/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    if (!body || !body.url || !body.clientRequest || body.quota === undefined || !body.price || !body.typeId) {
      throw new BusinessError('MISSING_FIELD', 'URL, clientRequest, quota, price, and typeId are required');
    }

    const { subreddit, url, clientRequest, quota, assignedTo, price, deadline, typeId } = body;

    // Validate inputs
    if (subreddit) {
      validateStringField(subreddit, 'Subreddit', 200);
    }
    validateStringField(url, 'Reddit URL', 2000);
    validateStringField(clientRequest, 'Client request', 5000);
    validateStringField(typeId, 'Type ID', 50);

    if (typeof quota !== 'number' || !Number.isInteger(quota) || quota < 1) {
      throw new BusinessError('INVALID_INPUT', 'Quota must be a positive integer');
    }
    if (typeof price !== 'number' || price <= 0) {
      throw new BusinessError('INVALID_INPUT', 'Price must be a positive number');
    }

    try { 
      new URL(url); 
    } catch {
      throw new BusinessError('INVALID_INPUT', 'Reddit URL must be a valid URL');
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    // Resolve assignedTo user ID from email or reddit name
    const resolvedAssignedTo = await resolveUserId(pool, assignedTo);

    // Verify task type exists
    const typeCheck = await pool.query('SELECT 1 FROM task_types WHERE id = $1 LIMIT 1', [typeId]);
    if (typeCheck.rows.length === 0) {
      throw new BusinessError('INVALID_INPUT', 'Invalid task type ID');
    }

    const result = await pool.query(
      `UPDATE tasks 
       SET subreddit = $1, url = $2, client_request = $3, quota = $4, assigned_to = $5, price = $6, deadline = $7, type_id = $8, updated_at = NOW()
       WHERE id = $9 
       RETURNING *`,
      [subreddit || null, url, clientRequest, quota, resolvedAssignedTo, price, deadline || null, typeId, id]
    );

    if (result.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'Task not found');
    }

    return c.json({ success: true, task: result.rows[0] });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin update task error');
    return c.json(body, status);
  }
});

// 4b. Delete a Task configuration
admin.delete('/tasks/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const pool = getDbPool(c.env.DATABASE_URL);

    const result = await pool.query(
      `DELETE FROM tasks WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'Task not found');
    }

    return c.json({ success: true, message: 'Task deleted successfully' });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin delete task error');
    return c.json(body, status);
  }
});

// 5. Review a user task submission (Pending -> Success or Failed)
admin.post('/tasks/review', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.bookingId || !body.statusId) {
      throw new BusinessError('MISSING_FIELD', 'Booking ID (bookingId) and Status (statusId: success/failed) are required');
    }

    const { bookingId, statusId, note } = body;
    if (statusId !== 'success' && statusId !== 'failed') {
      throw new BusinessError('INVALID_INPUT', 'Status must be either "success" or "failed"');
    }

    if (note && (typeof note !== 'string' || note.length > 5000)) {
      throw new BusinessError('INVALID_INPUT', 'Note is too long (max 5000 characters)');
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
      throw new BusinessError('NOT_FOUND', 'No pending task submission found matching this ID');
    }

    return c.json({ success: true, booking: result.rows[0] });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin review submission error');
    return c.json(body, status);
  }
});

// 6. Record PayPal payouts (Mark all accumulated 'success' tasks of a user as 'paid')
admin.post('/payouts', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.userId) {
      throw new BusinessError('MISSING_FIELD', 'User ID (userId) is required');
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
        throw new BusinessError('NO_PENDING_EARNINGS', 'User has no pending success tasks to pay.');
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
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin record payouts transaction error');
    return c.json(body, status);
  }
});

// 7. Get all pending user task submissions for Admin review
admin.get('/reviews/pending', async (c) => {
  try {
    const pool = getDbPool(c.env.DATABASE_URL);
    const result = await pool.query(
      `SELECT ut.id as booking_id, ut.status_id, ut.reply_url, ut.note, ut.created_at, ut.updated_at,
              u.email as user_email, u.reddit as user_reddit,
              t.id as task_id, t.subreddit, t.price
       FROM user_tasks ut
       JOIN users u ON ut.user_id = u.id
       JOIN tasks t ON ut.task_id = t.id
       WHERE ut.status_id = 'pending'
       ORDER BY ut.updated_at ASC`
    );
    return c.json({ success: true, bookings: result.rows });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin fetch pending reviews error');
    return c.json(body, status);
  }
});

export default admin;

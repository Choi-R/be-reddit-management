import { Hono } from 'hono';
import { getDbPool, withTransaction } from '../db/connection';
import { authMiddleware } from '../middleware/auth';
import { Env, Variables } from '../types';

const tasks = new Hono<{ Bindings: Env; Variables: Variables }>();

// All routes in this module require a valid authenticated session
tasks.use('/*', authMiddleware());

// 1. Fetch available tasks for the current user
tasks.get('/available', async (c) => {
  try {
    const user = c.get('user')!;
    const pool = getDbPool(c.env.DATABASE_URL);

    // Query details:
    // - Quota must be > 0
    // - Task must not have expired (deadline is null or in the future)
    // - Task is either unassigned or assigned explicitly to the current user
    // - User has no booking history for this task
    const availableTasks = await pool.query(
      `SELECT t.id, t.subreddit, t.post_url, t.client_request, t.quota, t.price, t.deadline, tt.type_name
       FROM tasks t
       JOIN task_types tt ON t.type_id = tt.id
       WHERE t.quota > 0
         AND (t.deadline IS NULL OR t.deadline > NOW())
         AND (t.assigned_to IS NULL OR t.assigned_to = $1)
         AND NOT EXISTS (
           SELECT 1 FROM user_tasks ut 
           WHERE ut.task_id = t.id AND ut.user_id = $1
         )
       ORDER BY t.created_at DESC`,
      [user.id]
    );

    // Fetch active task (if any) to help frontend manage states (e.g. show booking warning)
    const activeTask = await pool.query(
      `SELECT ut.id as booking_id, ut.status_id, ut.created_at as booked_at, t.*, tt.type_name
       FROM user_tasks ut
       JOIN tasks t ON ut.task_id = t.id
       JOIN task_types tt ON t.type_id = tt.id
       WHERE ut.user_id = $1 AND ut.status_id IN ('incomplete', 'pending')
       LIMIT 1`,
      [user.id]
    );

    return c.json({
      available: availableTasks.rows,
      active: activeTask.rows[0] || null
    });
  } catch (error: any) {
    console.error('Fetch available tasks error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// 2. Book an available task atomically
tasks.post('/book', async (c) => {
  try {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => null);
    if (!body || !body.taskId) {
      return c.json({ error: 'Task ID is required' }, 400);
    }

    const { taskId } = body;
    const pool = getDbPool(c.env.DATABASE_URL);

    // Run transaction to prevent race conditions (double bookings)
    const booking = await withTransaction(pool, async (client) => {
      // A. Check if the user has an active booking (incomplete/pending)
      const activeCheck = await client.query(
        `SELECT 1 FROM user_tasks 
         WHERE user_id = $1 AND status_id IN ('incomplete', 'pending')
         LIMIT 1`,
        [user.id]
      );
      if (activeCheck.rows.length > 0) {
        throw new Error('LIMIT_EXCEEDED: You can only perform one task at a time.');
      }

      // B. Check if user already did this task previously
      const historyCheck = await client.query(
        `SELECT 1 FROM user_tasks WHERE user_id = $1 AND task_id = $2 LIMIT 1`,
        [user.id, taskId]
      );
      if (historyCheck.rows.length > 0) {
        throw new Error('ALREADY_ATTEMPTED: You cannot perform the same task more than once.');
      }

      // C. Lock task row to check and decrement quota safely
      const taskCheck = await client.query(
        `SELECT quota, deadline, assigned_to FROM tasks WHERE id = $1 FOR UPDATE`,
        [taskId]
      );
      if (taskCheck.rows.length === 0) {
        throw new Error('NOT_FOUND: Task not found.');
      }

      const task = taskCheck.rows[0];

      // D. Verify task properties
      if (task.quota <= 0) {
        throw new Error('NO_QUOTA: Task is no longer available.');
      }
      if (task.deadline && new Date(task.deadline) <= new Date()) {
        throw new Error('EXPIRED: Task deadline has passed.');
      }
      if (task.assigned_to && task.assigned_to !== user.id) {
        throw new Error('FORBIDDEN: This task is assigned to another user.');
      }

      // E. Decrement task quota
      await client.query(
        `UPDATE tasks SET quota = quota - 1, updated_at = NOW() WHERE id = $1`,
        [taskId]
      );

      // F. Create user_tasks record (status: incomplete)
      const insertResult = await client.query(
        `INSERT INTO user_tasks (user_id, task_id, status_id, created_at, updated_at)
         VALUES ($1, $2, 'incomplete', NOW(), NOW())
         RETURNING *`,
        [user.id, taskId]
      );

      return insertResult.rows[0];
    });

    return c.json({ success: true, booking });
  } catch (error: any) {
    const msg = error.message || '';
    if (
      msg.startsWith('LIMIT_EXCEEDED') ||
      msg.startsWith('ALREADY_ATTEMPTED') ||
      msg.startsWith('NOT_FOUND') ||
      msg.startsWith('NO_QUOTA') ||
      msg.startsWith('EXPIRED') ||
      msg.startsWith('FORBIDDEN')
    ) {
      const [code, desc] = msg.split(': ');
      return c.json({ error: desc, code }, 400);
    }
    console.error('Book task transaction error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// 3. Submit task completion (reply URL)
tasks.post('/submit', async (c) => {
  try {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => null);
    if (!body || !body.taskId || !body.replyUrl) {
      return c.json({ error: 'Task ID and Reddit reply URL are required' }, 400);
    }

    const { taskId, replyUrl, note } = body;
    const pool = getDbPool(c.env.DATABASE_URL);

    // Update state to pending if it is currently incomplete
    const result = await pool.query(
      `UPDATE user_tasks 
       SET status_id = 'pending', reply_url = $1, note = COALESCE($2, note), updated_at = NOW()
       WHERE user_id = $3 AND task_id = $4 AND status_id = 'incomplete'
       RETURNING *`,
      [replyUrl, note || null, user.id, taskId]
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'No active incomplete booking found for this task' }, 400);
    }

    return c.json({ success: true, booking: result.rows[0] });
  } catch (error: any) {
    console.error('Submit task error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// 4. Fetch earnings statistics and booking history
tasks.get('/earnings', async (c) => {
  try {
    const user = c.get('user')!;
    const pool = getDbPool(c.env.DATABASE_URL);

    // A. Fetch task list with payouts
    const history = await pool.query(
      `SELECT ut.id as booking_id, ut.status_id, ut.reply_url, ut.note, ut.created_at, ut.updated_at,
              t.id as task_id, t.subreddit, t.price, tt.type_name
       FROM user_tasks ut
       JOIN tasks t ON ut.task_id = t.id
       JOIN task_types tt ON t.type_id = tt.id
       WHERE ut.user_id = $1 AND ut.status_id IN ('success', 'paid', 'failed')
       ORDER BY ut.updated_at DESC`,
      [user.id]
    );

    // B. Calculate paid earnings (Sum of price where status_id = paid)
    const paidRes = await pool.query(
      `SELECT COALESCE(SUM(t.price), 0.00) as balance 
       FROM user_tasks ut
       JOIN tasks t ON ut.task_id = t.id
       WHERE ut.user_id = $1 AND ut.status_id = 'paid'`,
      [user.id]
    );

    // C. Calculate pending earnings (Sum of price where status_id = success)
    const pendingRes = await pool.query(
      `SELECT COALESCE(SUM(t.price), 0.00) as balance 
       FROM user_tasks ut
       JOIN tasks t ON ut.task_id = t.id
       WHERE ut.user_id = $1 AND ut.status_id = 'success'`,
      [user.id]
    );

    return c.json({
      history: history.rows,
      paidBalance: parseFloat(paidRes.rows[0].balance),
      pendingBalance: parseFloat(pendingRes.rows[0].balance)
    });
  } catch (error: any) {
    console.error('Fetch earnings statistics error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

export default tasks;

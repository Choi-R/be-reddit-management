import { Hono } from 'hono';
import { getDbPool, withTransaction } from '../db/connection';
import { authMiddleware } from '../middleware/auth';
import { BusinessError, handleRouteError } from '../utils/errors';
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
      `SELECT t.id, t.subreddit, t.url, t.client_request, t.quota, t.price, t.deadline, tt.type_name
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

    // Fetch active tasks (up to 2) to help frontend manage states (e.g. show booking warning)
    const activeTask = await pool.query(
      `SELECT ut.id as booking_id, ut.status_id, ut.created_at as booked_at, t.*, tt.type_name
       FROM user_tasks ut
       JOIN tasks t ON ut.task_id = t.id
       JOIN task_types tt ON t.type_id = tt.id
       WHERE ut.user_id = $1 AND ut.status_id IN ('incomplete', 'pending')
       LIMIT 2`,
      [user.id]
    );

    return c.json({
      available: availableTasks.rows,
      active: activeTask.rows
    });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Fetch available tasks error');
    return c.json(body, status);
  }
});

// 2. Book an available task atomically
tasks.post('/book', async (c) => {
  try {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => null);
    if (!body || !body.taskId) {
      throw new BusinessError('MISSING_FIELD', 'Task ID is required');
    }

    const { taskId } = body;
    if (typeof taskId !== 'string' || taskId.length > 100) {
      throw new BusinessError('INVALID_INPUT', 'Task ID must be a valid string');
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    // Run transaction to prevent race conditions (double bookings)
    const booking = await withTransaction(pool, async (client) => {
      // A. Check if the user has active bookings (incomplete/pending)
      const activeCheck = await client.query(
        `SELECT COUNT(*)::int as count FROM user_tasks 
         WHERE user_id = $1 AND status_id IN ('incomplete', 'pending')`,
        [user.id]
      );
      if (activeCheck.rows[0].count >= 2) {
        throw new BusinessError('LIMIT_EXCEEDED', 'You can only perform at most 2 tasks at a time.');
      }

      // B. Check if user already did this task previously
      const historyCheck = await client.query(
        `SELECT 1 FROM user_tasks WHERE user_id = $1 AND task_id = $2 LIMIT 1`,
        [user.id, taskId]
      );
      if (historyCheck.rows.length > 0) {
        throw new BusinessError('ALREADY_ATTEMPTED', 'You cannot perform the same task more than once.');
      }

      // C. Lock task row to check and decrement quota safely
      const taskCheck = await client.query(
        `SELECT quota, deadline, assigned_to FROM tasks WHERE id = $1 FOR UPDATE`,
        [taskId]
      );
      if (taskCheck.rows.length === 0) {
        throw new BusinessError('NOT_FOUND', 'Task not found.');
      }

      const task = taskCheck.rows[0];

      // D. Verify task properties
      if (task.quota <= 0) {
        throw new BusinessError('NO_QUOTA', 'Task is no longer available.');
      }
      if (task.deadline && new Date(task.deadline) <= new Date()) {
        throw new BusinessError('EXPIRED', 'Task deadline has passed.');
      }
      if (task.assigned_to && task.assigned_to !== user.id) {
        throw new BusinessError('FORBIDDEN', 'This task is assigned to another user.', 403);
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
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Book task transaction error');
    return c.json(body, status);
  }
});

// 3. Cancel task booking atomically (second-thought)
tasks.post('/cancel', async (c) => {
  try {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => null);
    if (!body || !body.taskId) {
      throw new BusinessError('MISSING_FIELD', 'Task ID is required');
    }

    const { taskId } = body;
    if (typeof taskId !== 'string' || taskId.length > 100) {
      throw new BusinessError('INVALID_INPUT', 'Task ID must be a valid string');
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    await withTransaction(pool, async (client) => {
      // A. Check if the user has an active incomplete booking for this task
      const bookingCheck = await client.query(
        `SELECT id FROM user_tasks 
         WHERE user_id = $1 AND task_id = $2 AND status_id = 'incomplete'
         FOR UPDATE`,
        [user.id, taskId]
      );

      if (bookingCheck.rows.length === 0) {
        throw new BusinessError('NOT_FOUND', 'No active incomplete booking found for this task.');
      }

      // B. Lock task row to update quota safely
      const taskCheck = await client.query(
        `SELECT id FROM tasks WHERE id = $1 FOR UPDATE`,
        [taskId]
      );

      if (taskCheck.rows.length === 0) {
        throw new BusinessError('NOT_FOUND', 'Task not found.');
      }

      // C. Delete the user_tasks record
      await client.query(
        `DELETE FROM user_tasks WHERE user_id = $1 AND task_id = $2 AND status_id = 'incomplete'`,
        [user.id, taskId]
      );

      // D. Increment task quota
      await client.query(
        `UPDATE tasks SET quota = quota + 1, updated_at = NOW() WHERE id = $1`,
        [taskId]
      );
    });

    return c.json({ success: true });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Cancel task booking transaction error');
    return c.json(body, status);
  }
});

// 3. Submit task completion (reply URL)
tasks.post('/submit', async (c) => {
  try {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => null);
    if (!body || !body.taskId || !body.replyUrl) {
      throw new BusinessError('MISSING_FIELD', 'Task ID and Reddit reply URL are required');
    }

    const { taskId, replyUrl, note } = body;

    // Validate URL format
    try {
      new URL(replyUrl);
    } catch {
      throw new BusinessError('INVALID_INPUT', 'Reply URL must be a valid URL');
    }

    // Validate field lengths
    if (typeof replyUrl !== 'string' || replyUrl.length > 2000) {
      throw new BusinessError('INVALID_INPUT', 'Reply URL is too long (max 2000 characters)');
    }
    if (note && (typeof note !== 'string' || note.length > 5000)) {
      throw new BusinessError('INVALID_INPUT', 'Note is too long (max 5000 characters)');
    }

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
      throw new BusinessError('NOT_FOUND', 'No active incomplete booking found for this task');
    }

    return c.json({ success: true, booking: result.rows[0] });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Submit task error');
    return c.json(body, status);
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
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Fetch earnings statistics error');
    return c.json(body, status);
  }
});

export default tasks;

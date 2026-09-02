import { Hono } from 'hono';
import { getDbPool, withTransaction } from '../db/connection';
import { authMiddleware } from '../middleware/auth';
import { BusinessError, handleRouteError } from '../utils/errors';
import { Env, Variables } from '../types';
import { rateLimiter } from '../middleware/rateLimit';

const tasks = new Hono<{ Bindings: Env; Variables: Variables }>();

// Rate limiter for write operations (book, cancel, submit) - Max 10 requests per minute per user/IP
const writeLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many booking or submission actions. Please wait a minute.'
});

// All routes in this module require a valid authenticated session
tasks.use('/*', authMiddleware());

interface CooldownResult {
  isActive: boolean;
  cooldownUntil: string | null;
  remainingMs: number;
  lastSubmittedAt: string | null;
  reason: string | null;
}

async function getUserCooldownStatus(
  userId: string,
  executor: { query: (sql: string, params: any[]) => Promise<any> },
  isAdmin: boolean,
  userRankLevel: number
): Promise<CooldownResult> {
  if (isAdmin) {
    return {
      isActive: false,
      cooldownUntil: null,
      remainingMs: 0,
      lastSubmittedAt: null,
      reason: null,
    };
  }

  // Rank A (4) and Rank S (5) are exempt from cooldown
  if (userRankLevel >= 4) {
    return {
      isActive: false,
      cooldownUntil: null,
      remainingMs: 0,
      lastSubmittedAt: null,
      reason: null,
    };
  }

  const result = await executor.query(
    `SELECT COALESCE(submitted_at, updated_at) as submit_time
     FROM user_tasks
     WHERE user_id = $1 
       AND (submitted_at IS NOT NULL OR status_id IN ('pending', 'success', 'paid', 'failed'))
     ORDER BY COALESCE(submitted_at, updated_at) DESC
     LIMIT 1`,
    [userId]
  );

  if (result.rows.length === 0 || !result.rows[0].submit_time) {
    return {
      isActive: false,
      cooldownUntil: null,
      remainingMs: 0,
      lastSubmittedAt: null,
      reason: null,
    };
  }

  const lastSubmittedAt = new Date(result.rows[0].submit_time);
  const cooldownMs = 1 * 24 * 60 * 60 * 1000; // 24 hours
  const cooldownUntil = new Date(lastSubmittedAt.getTime() + cooldownMs);
  const now = new Date();

  if (now < cooldownUntil) {
    const remainingMs = cooldownUntil.getTime() - now.getTime();
    const remainingHours = Math.ceil(remainingMs / (1000 * 60 * 60));
    return {
      isActive: true,
      cooldownUntil: cooldownUntil.toISOString(),
      remainingMs,
      lastSubmittedAt: lastSubmittedAt.toISOString(),
      reason: `A 1-day cooldown period is active following your recent task submission. Next booking available in approximately ${remainingHours} hours.`,
    };
  }

  return {
    isActive: false,
    cooldownUntil: cooldownUntil.toISOString(),
    remainingMs: 0,
    lastSubmittedAt: lastSubmittedAt.toISOString(),
    reason: null,
  };
}

// 1. Fetch available tasks for the current user
tasks.get('/available', async (c) => {
  try {
    const user = c.get('user')!;
    const pool = getDbPool(c.env.DATABASE_URL);
    const isAdmin = user.roles.includes('admin') || user.roles.includes('choi');

    // Query details:
    // - Quota must be > 0
    // - Task must not have expired (deadline is null or in the future)
    // - Task is either unassigned or assigned explicitly to the current user
    // - User has no booking history for this task
    const platformFilter = c.req.query('platform') || '';
    const platformWhere = platformFilter && ['REDDIT', 'PRODUCTHUNT'].includes(platformFilter.toUpperCase())
      ? `AND t.platform = $${paramIdx++}`
      : '';
    const platformParam = platformFilter.toUpperCase();

    const availableTasks = await pool.query(
      `SELECT t.id, t.platform, t.target_subreddit, t.url, t.client_request, t.quota, COALESCE(NULLIF(t.original_quota, 0), NULLIF(t.quota, 0), 1) as original_quota,
              t.price, t.deadline, t.min_rank_id, ar.rank_name as min_rank_name, ar.cqm_level as min_rank_cqm, ar.rank_level as min_rank_level
       FROM tasks t
       LEFT JOIN account_ranks ar ON t.min_rank_id = ar.id
       WHERE t.quota > 0
         AND (t.deadline IS NULL OR t.deadline > NOW())
         AND (t.assigned_to IS NULL OR t.assigned_to = $1)
         AND t.deleted_at IS NULL
         AND t.is_archived = FALSE
         AND (SELECT COUNT(*)::int FROM user_tasks ut WHERE ut.task_id = t.id AND ut.status_id = 'failed') < (3 * COALESCE(NULLIF(t.original_quota, 0), NULLIF(t.quota, 0), 1))
         AND NOT EXISTS (
           SELECT 1 FROM user_tasks ut 
           WHERE ut.task_id = t.id AND ut.user_id = $1
         )
         ${platformWhere}
       ORDER BY t.created_at DESC`,
      platformParam ? [user.id, platformParam] : [user.id]
    );

    // Fetch active tasks to help frontend manage states (e.g. show booking warning)
    const activeTask = await pool.query(
      `SELECT ut.id as booking_id, ut.status_id, ut.created_at as booked_at, t.*, ar.rank_name as min_rank_name
       FROM user_tasks ut
       JOIN tasks t ON ut.task_id = t.id
       LEFT JOIN account_ranks ar ON t.min_rank_id = ar.id
       WHERE ut.user_id = $1 AND ut.status_id IN ('incomplete', 'pending')
       ORDER BY ut.created_at DESC`,
      [user.id]
    );

    const userRankLevel = user.account_rank?.rank_level ?? 1;
    const cooldown = await getUserCooldownStatus(user.id, pool, isAdmin, userRankLevel);

    return c.json({
      available: availableTasks.rows,
      active: activeTask.rows,
      cooldown
    });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Fetch available tasks error');
    return c.json(body, status);
  }
});

// 2. Book an available task atomically
tasks.post('/book', writeLimiter, async (c) => {
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
      // A1. Lock task row first to serialize concurrent booking attempts
      const taskCheck = await client.query(
        `SELECT tasks.quota, COALESCE(NULLIF(tasks.original_quota, 0), NULLIF(tasks.quota, 0), 1) as original_quota,
                tasks.deadline, tasks.assigned_to, tasks.deleted_at, tasks.is_archived, tasks.min_rank_id,
                ar.rank_name as min_rank_name, COALESCE(ar.rank_level, 0) as min_rank_level,
                (SELECT COUNT(*)::int FROM user_tasks ut WHERE ut.task_id = tasks.id AND ut.status_id = 'failed') as count_failed
         FROM tasks
         LEFT JOIN account_ranks ar ON tasks.min_rank_id = ar.id
         WHERE tasks.id = $1 FOR UPDATE OF tasks`,
        [taskId]
      );
      if (taskCheck.rows.length === 0) {
        throw new BusinessError('NOT_FOUND', 'Task not found.');
      }

      const task = taskCheck.rows[0];

      // A2. Get user's account rank level
      const userRankRes = await client.query(
        `SELECT u.rank_id, ar.rank_name, COALESCE(ar.rank_level, 1) as rank_level
         FROM users u
         LEFT JOIN account_ranks ar ON u.rank_id = ar.id
         WHERE u.id = $1`,
        [user.id]
      );
      const userRankInfo = userRankRes.rows[0] || { rank_id: 'D', rank_name: 'Rank D', rank_level: 1 };
      const userRankLevel = userRankInfo.rank_level;

      const isAdmin = user.roles.includes('admin') || user.roles.includes('choi');
      const bookingLimit = isAdmin ? 99 : 1;

      // A2.5. Check post-submission cooldown restriction
      const cooldown = await getUserCooldownStatus(user.id, client, isAdmin, userRankLevel);
      if (cooldown.isActive) {
        const remainingHours = Math.ceil(cooldown.remainingMs / (1000 * 60 * 60));
        throw new BusinessError(
          'COOLDOWN_ACTIVE',
          `You cannot book a task right now. A 1-day cooldown period is active following your task submission on ${new Date(cooldown.lastSubmittedAt!).toLocaleString()}. Available in approx ${remainingHours} hours.`
        );
      }

      // A3. Check if the user has active bookings (incomplete)
      const activeCheck = await client.query(
        `SELECT COUNT(*)::int as count FROM user_tasks 
         WHERE user_id = $1 AND status_id = 'incomplete'`,
        [user.id]
      );
      if (activeCheck.rows[0].count >= bookingLimit) {
        throw new BusinessError(
          'LIMIT_EXCEEDED',
          `You can only book at most ${bookingLimit} task${bookingLimit === 1 ? '' : 's'} at a time.`
        );
      }

      // B. Check if user already did this task previously (now protected by FOR UPDATE lock)
      const historyCheck = await client.query(
        `SELECT 1 FROM user_tasks WHERE user_id = $1 AND task_id = $2 LIMIT 1`,
        [user.id, taskId]
      );
      if (historyCheck.rows.length > 0) {
        throw new BusinessError('ALREADY_ATTEMPTED', 'You cannot perform the same task more than once.');
      }

      // C. Verify task properties
      if (task.deleted_at) {
        throw new BusinessError('EXPIRED', 'This task is no longer available.');
      }
      if (task.is_archived) {
        throw new BusinessError('EXPIRED', 'This task has been archived.');
      }
      if (task.quota <= 0) {
        throw new BusinessError('NO_QUOTA', 'Task is no longer available.');
      }
      if (task.deadline && new Date(task.deadline) <= new Date()) {
        throw new BusinessError('EXPIRED', 'Task deadline has passed.');
      }
      const origQuota = (typeof task.original_quota === 'number' && task.original_quota > 0) ? task.original_quota : ((typeof task.quota === 'number' && task.quota > 0) ? task.quota : 1);
      const maxFailThreshold = 3 * origQuota;
      if ((task.count_failed || 0) >= maxFailThreshold) {
        throw new BusinessError('EXPIRED', 'This task has been archived due to excessive failed attempts.');
      }
      if (task.assigned_to && task.assigned_to !== user.id) {
        throw new BusinessError('FORBIDDEN', 'This task is assigned to another user.', 403);
      }

      // C2. Enforce Minimum Rank Requirement & Rank E (Banned Account) restriction
      if (!isAdmin) {
        if (userRankInfo.rank_id === 'E' || userRankLevel <= 0) {
          throw new BusinessError(
            'INSUFFICIENT_RANK',
            'Your account is Rank E (banned account) and cannot book or perform any tasks.'
          );
        }
        if (task.min_rank_id) {
          const requiredRankLevel = typeof task.min_rank_level === 'number' ? task.min_rank_level : 1;
          if (userRankLevel < requiredRankLevel) {
            throw new BusinessError(
              'INSUFFICIENT_RANK',
              `This task requires ${task.min_rank_name || 'Rank ' + task.min_rank_id}. Your current account rank is ${userRankInfo.rank_name}.`
            );
          }
        }
      }

      // D. Decrement task quota
      await client.query(
        `UPDATE tasks SET quota = quota - 1, updated_at = NOW() WHERE id = $1`,
        [taskId]
      );

      // E. Create user_tasks record (status: incomplete)
      try {
        const insertResult = await client.query(
          `INSERT INTO user_tasks (user_id, task_id, status_id, created_at, updated_at)
           VALUES ($1, $2, 'incomplete', NOW(), NOW())
           RETURNING *`,
          [user.id, taskId]
        );

        return insertResult.rows[0];
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
          throw new BusinessError('ALREADY_ATTEMPTED', 'You cannot perform the same task more than once.');
        }
        throw err;
      }
    });

    return c.json({ success: true, booking });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Book task transaction error');
    return c.json(body, status);
  }
});

// 3. Cancel task booking atomically (second-thought)
tasks.post('/cancel', writeLimiter, async (c) => {
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
tasks.post('/submit', writeLimiter, async (c) => {
  try {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => null);
    if (!body || !body.taskId || !body.replyUrl) {
      throw new BusinessError('MISSING_FIELD', 'Task ID and Reddit reply URL are required');
    }

    const { taskId, replyUrl, note } = body;

    // Validate URL format, protocol, and domain
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(replyUrl);
    } catch {
      throw new BusinessError('INVALID_INPUT', 'Reply URL must be a valid URL');
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new BusinessError('INVALID_INPUT', 'Reply URL must use HTTP or HTTPS protocol');
    }

    // Validate field lengths
    if (typeof replyUrl !== 'string' || replyUrl.length > 2000) {
      throw new BusinessError('INVALID_INPUT', 'Reply URL is too long (max 2000 characters)');
    }
    if (note && (typeof note !== 'string' || note.length > 5000)) {
      throw new BusinessError('INVALID_INPUT', 'Note is too long (max 5000 characters)');
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    // 1. Fetch task details to check platform and subreddit restriction
    const taskResult = await pool.query(
      'SELECT platform, subreddit FROM tasks WHERE id = $1',
      [taskId]
    );

    if (taskResult.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'Task not found');
    }
    const taskPlatform = taskResult.rows[0].platform || 'REDDIT';
    const taskSubreddit = taskResult.rows[0].subreddit;

    // 2. Validate URL domain based on platform
    const host = parsedUrl.hostname.toLowerCase();
    if (taskPlatform === 'PRODUCTHUNT') {
      const isProductHuntHost = host === 'producthunt.com' || host.endsWith('.producthunt.com');
      if (!isProductHuntHost) {
        throw new BusinessError('INVALID_INPUT', 'Reply URL must be a producthunt.com domain link');
      }
    } else {
      const isRedditHost = host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'redd.it';
      if (!isRedditHost) {
        throw new BusinessError('INVALID_INPUT', 'Reply URL must be a reddit.com domain link');
      }
    }

    // 3. Validate subreddit matching if restricted by the task
    if (taskSubreddit) {
      const pathParts = parsedUrl.pathname.split('/');
      const rIdx = pathParts.findIndex(part => part.toLowerCase() === 'r');
      if (rIdx === -1 || !pathParts[rIdx + 1] || pathParts[rIdx + 1].toLowerCase() !== taskSubreddit.toLowerCase()) {
        throw new BusinessError(
          'INVALID_INPUT',
          `The submitted URL does not match the required subreddit. Expected: r/${taskSubreddit}`
        );
      }
    }

    // 4. Atomically verify duplicate URL and submit task inside a transaction
    const booking = await withTransaction(pool, async (client) => {
      const duplicateCheck = await client.query(
        'SELECT 1 FROM user_tasks WHERE reply_url = $1 LIMIT 1',
        [replyUrl]
      );
      if (duplicateCheck.rows.length > 0) {
        throw new BusinessError('DUPLICATE_SUBMISSION', 'This URL has already been submitted for a task.');
      }

      const result = await client.query(
        `UPDATE user_tasks 
         SET status_id = 'pending', reply_url = $1, note = COALESCE($2, note), submitted_at = NOW(), updated_at = NOW()
         WHERE user_id = $3 AND task_id = $4 AND status_id = 'incomplete'
         RETURNING *`,
        [replyUrl, note || null, user.id, taskId]
      );

      if (result.rows.length === 0) {
        throw new BusinessError('NOT_FOUND', 'No active incomplete booking found for this task');
      }

      return result.rows[0];
    });

    return c.json({ success: true, booking });
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
      `SELECT ut.id as booking_id, ut.status_id, ut.reply_url, ut.note, ut.admin_note, ut.created_at, ut.updated_at,
              t.id as task_id, t.subreddit, t.price, t.min_rank_id, ar.rank_name as min_rank_name
       FROM user_tasks ut
       JOIN tasks t ON ut.task_id = t.id
       LEFT JOIN account_ranks ar ON t.min_rank_id = ar.id
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

// 5. Fetch full personal tasking history with filtering for the current user
tasks.get('/history', async (c) => {
  try {
    const user = c.get('user')!;
    const rawStatuses = c.req.query('statuses') || c.req.query('status') || '';
    const search = (c.req.query('search') || '').trim();

    const pool = getDbPool(c.env.DATABASE_URL);

    // Parse status array if provided
    let statusFilter: string[] = [];
    if (rawStatuses) {
      statusFilter = rawStatuses
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => ['incomplete', 'pending', 'success', 'paid', 'failed'].includes(s));
    }

    const whereClauses: string[] = ['ut.user_id = $1'];
    const queryParams: any[] = [user.id];
    let paramIdx = 2;

    if (statusFilter.length > 0) {
      whereClauses.push(`ut.status_id = ANY($${paramIdx})`);
      queryParams.push(statusFilter);
      paramIdx++;
    }

    if (search) {
      whereClauses.push(
        `(t.subreddit ILIKE $${paramIdx} OR t.client_request ILIKE $${paramIdx} OR ut.reply_url ILIKE $${paramIdx} OR ut.note ILIKE $${paramIdx} OR ut.admin_note ILIKE $${paramIdx})`
      );
      queryParams.push(`%${search}%`);
      paramIdx++;
    }

    const whereSql = `WHERE ${whereClauses.join(' AND ')}`;

    const historyQuery = `
      SELECT ut.id as booking_id, ut.status_id, ut.reply_url, ut.note, ut.admin_note,
             ut.created_at, ut.updated_at,
             t.id as task_id, t.subreddit, t.url as task_url, t.client_request, t.price, t.deadline,
             ar.rank_name as min_rank_name
      FROM user_tasks ut
      JOIN tasks t ON ut.task_id = t.id
      LEFT JOIN account_ranks ar ON t.min_rank_id = ar.id
      ${whereSql}
      ORDER BY ut.updated_at DESC, ut.created_at DESC
    `;

    const statusCountsQuery = `
      SELECT 
        COALESCE(SUM(CASE WHEN ut.status_id = 'incomplete' THEN 1 ELSE 0 END)::int, 0) as incomplete,
        COALESCE(SUM(CASE WHEN ut.status_id = 'pending' THEN 1 ELSE 0 END)::int, 0) as pending,
        COALESCE(SUM(CASE WHEN ut.status_id = 'success' THEN 1 ELSE 0 END)::int, 0) as success,
        COALESCE(SUM(CASE WHEN ut.status_id = 'paid' THEN 1 ELSE 0 END)::int, 0) as paid,
        COALESCE(SUM(CASE WHEN ut.status_id = 'failed' THEN 1 ELSE 0 END)::int, 0) as failed,
        COUNT(*)::int as total
      FROM user_tasks ut
      WHERE ut.user_id = $1
    `;

    const [historyRes, countsRes] = await Promise.all([
      pool.query(historyQuery, queryParams),
      pool.query(statusCountsQuery, [user.id]),
    ]);

    return c.json({
      success: true,
      history: historyRes.rows,
      total: historyRes.rows.length,
      statusCounts: countsRes.rows[0] || { incomplete: 0, pending: 0, success: 0, paid: 0, failed: 0, total: 0 },
    });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Fetch user tasking history error');
    return c.json(body, status);
  }
});

export default tasks;


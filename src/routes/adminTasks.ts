import { Hono } from 'hono';
import { getDbPool, withTransaction } from '../db/connection';
import { BusinessError, handleRouteError } from '../utils/errors';
import { Env, Variables } from '../types';
import { validateStringField, extractRedditUsername } from '../utils/validation';
import { checkAndNotifyTelegramTaskCreated, sendTelegramNotification } from '../utils/telegram';

const adminTasks = new Hono<{ Bindings: Env; Variables: Variables }>();

// Helper to resolve user ID from email, reddit username, or UUID string
async function resolveUserId(pool: any, identifier: string | null | undefined): Promise<string | null> {
  if (!identifier || identifier.trim() === '') {
    return null;
  }

  const cleanVal = identifier.trim();
  const strippedReddit = extractRedditUsername(cleanVal);

  const userRes = await pool.query(
    `SELECT id FROM users 
     WHERE email = $1 
        OR reddit = $1 
        OR reddit = $2
        OR nickname = $1
        OR id::text = $1 
     LIMIT 1`,
    [cleanVal, strippedReddit]
  );

  if (userRes.rows.length === 0) {
    throw new BusinessError('NOT_FOUND', `Assigned user with email, reddit username, or UUID "${identifier}" not found`);
  }

  return userRes.rows[0].id;
}

// 1. Create a new Task configuration
adminTasks.post('/tasks', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.url || !body.clientRequest || body.quota === undefined || !body.price) {
      throw new BusinessError('MISSING_FIELD', 'URL, clientRequest, quota, and price are required');
    }

    const { url, clientRequest, quota, assignedTo, price, deadline, minRankId, min_rank_id } = body;
    const targetMinRankId = minRankId || min_rank_id || null;
    const platform = (body.platform || 'REDDIT').toUpperCase() as 'REDDIT' | 'PRODUCTHUNT';
    let targetSubreddit = body.target_subreddit || body.subreddit || null;

    if (platform === 'REDDIT' && url) {
      const match = url.match(/\/r\/([a-zA-Z0-9_]+)/i);
      if (match) {
        targetSubreddit = match[1];
      }
    }

    if (targetSubreddit) {
      validateStringField(targetSubreddit, 'Target subreddit', 200);
    }
    validateStringField(url, 'URL', 2000);
    validateStringField(clientRequest, 'Client request', 5000);
    if (targetMinRankId) {
      validateStringField(targetMinRankId, 'Minimum Rank ID', 50);
    }

    if (typeof quota !== 'number' || !Number.isInteger(quota) || quota < 1) {
      throw new BusinessError('INVALID_INPUT', 'Quota must be a positive integer');
    }
    if (typeof price !== 'number' || price <= 0) {
      throw new BusinessError('INVALID_INPUT', 'Price must be a positive number');
    }

    try {
      new URL(url);
    } catch {
      throw new BusinessError('INVALID_INPUT', 'URL must be a valid URL');
    }

    const pool = getDbPool(c.env.DATABASE_URL);
    const resolvedAssignedTo = await resolveUserId(pool, assignedTo);

    if (targetMinRankId) {
      const rankCheck = await pool.query('SELECT 1 FROM account_ranks WHERE id = $1 LIMIT 1', [targetMinRankId]);
      if (rankCheck.rows.length === 0) {
        throw new BusinessError('INVALID_INPUT', 'Invalid minimum rank ID');
      }
    }

    // Check Telegram notification cooldown (12h since latest task) BEFORE inserting new task
    const telegramResult = await checkAndNotifyTelegramTaskCreated(pool, c.env, 1);

    const result = await pool.query(
      `INSERT INTO tasks (platform, target_subreddit, url, client_request, quota, original_quota, assigned_to, price, deadline, min_rank_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, NOW(), NOW())
       RETURNING *`,
      [platform, targetSubreddit || null, url, clientRequest, quota, resolvedAssignedTo, price, deadline || null, targetMinRankId]
    );

    return c.json({
      success: true,
      task: result.rows[0],
      telegramNotified: telegramResult.notified,
      telegramReason: telegramResult.reason
    });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin create task error');
    return c.json(body, status);
  }
});

// 2. Bulk create tasks
adminTasks.post('/tasks/bulk', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.tasks)) {
      throw new BusinessError('MISSING_FIELD', 'An array of tasks is required');
    }

    const { tasks } = body;
    if (tasks.length === 0) {
      throw new BusinessError('INVALID_INPUT', 'Tasks list cannot be empty');
    }
    if (tasks.length > 500) {
      throw new BusinessError('INVALID_INPUT', 'Cannot bulk import more than 500 tasks at a time');
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    const validatedTasks: Array<{
      platform: 'REDDIT' | 'PRODUCTHUNT';
      targetSubreddit: string | null;
      url: string;
      clientRequest: string;
      quota: number;
      price: number;
      deadline: string | null;
      minRankId: string | null;
    }> = [];

    for (let i = 0; i < tasks.length; i++) {
      const rowNum = i + 1;
      const t = tasks[i];
      if (!t || typeof t !== 'object') {
        throw new BusinessError('INVALID_INPUT', `Task at row ${rowNum} is not a valid object`);
      }

      const { url, clientRequest, deadline, price, minRankId, min_rank_id, minRank, platform, target_subreddit, subreddit } = t;

      if (typeof url !== 'string' || url.trim().length === 0) {
        throw new BusinessError('MISSING_FIELD', `Row ${rowNum}: URL is required`);
      }
      if (url.length > 2000) {
        throw new BusinessError('INVALID_INPUT', `Row ${rowNum}: URL is too long (max 2000 characters)`);
      }
      try {
        new URL(url);
      } catch {
        throw new BusinessError('INVALID_INPUT', `Row ${rowNum}: URL must be a valid URL`);
      }

      if (typeof clientRequest !== 'string' || clientRequest.trim().length === 0) {
        throw new BusinessError('MISSING_FIELD', `Row ${rowNum}: Client request is required`);
      }
      if (clientRequest.length > 5000) {
        throw new BusinessError('INVALID_INPUT', `Row ${rowNum}: Client request is too long (max 5000 characters)`);
      }

      const parsedPrice = parseFloat(price);
      if (isNaN(parsedPrice) || parsedPrice <= 0) {
        throw new BusinessError('INVALID_INPUT', `Row ${rowNum}: Price must be a positive number`);
      }

      let parsedDeadline: string | null = null;
      if (deadline) {
        const d = new Date(deadline);
        if (isNaN(d.getTime())) {
          throw new BusinessError('INVALID_INPUT', `Row ${rowNum}: Deadline must be a valid date`);
        }
        parsedDeadline = d.toISOString();
      }

      const taskPlatform = (platform || 'REDDIT').toUpperCase() as 'REDDIT' | 'PRODUCTHUNT';
      let targetSubreddit: string | null = target_subreddit || subreddit || null;
      if (taskPlatform === 'REDDIT' && url) {
        const match = url.match(/\/r\/([a-zA-Z0-9_]+)/i);
        if (match) {
          targetSubreddit = match[1];
        }
      }
      if (targetSubreddit && targetSubreddit.length > 200) {
        throw new BusinessError('INVALID_INPUT', `Row ${rowNum}: Subreddit name is too long (max 200 characters)`);
      }

      const rawMinRank = minRankId || min_rank_id || minRank || null;
      const targetMinRank = (rawMinRank && ['D', 'C', 'B', 'A', 'S'].includes(rawMinRank.toString().toUpperCase()))
        ? rawMinRank.toString().toUpperCase()
        : null;

      validatedTasks.push({
        platform: taskPlatform,
        targetSubreddit,
        url,
        clientRequest,
        quota: 1,
        price: parsedPrice,
        deadline: parsedDeadline,
        minRankId: targetMinRank,
      });
    }

    // Check Telegram notification cooldown (12h since latest task) BEFORE bulk inserting new tasks
    const telegramResult = await checkAndNotifyTelegramTaskCreated(pool, c.env, validatedTasks.length);

    const insertedTasks = await withTransaction(pool, async (client) => {
      const results = [];
      for (const t of validatedTasks) {
        const res = await client.query(
          `INSERT INTO tasks (platform, target_subreddit, url, client_request, quota, original_quota, assigned_to, price, deadline, min_rank_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4, NULL, $5, $6, $7, $8, NOW(), NOW())
           RETURNING *`,
          [t.platform, t.targetSubreddit, t.url, t.clientRequest, t.quota, t.price, t.deadline, t.minRankId]
        );
        results.push(res.rows[0]);
      }
      return results;
    });

    return c.json({
      success: true,
      count: insertedTasks.length,
      tasks: insertedTasks,
      telegramNotified: telegramResult.notified,
      telegramReason: telegramResult.reason
    });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin bulk create tasks error');
    return c.json(body, status);
  }
});

// Test Telegram Bot integration endpoint (bypasses 12h cooldown)
adminTasks.post('/tasks/test-telegram', async (c) => {
  try {
    const res = await sendTelegramNotification(
      c.env,
      '🧪 <b>Test Notification</b>\n\nTelegram Bot is successfully connected to your Reddit Management CRM!'
    );
    return c.json({ success: res.success, reason: res.reason });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Test telegram error');
    return c.json(body, status);
  }
});

// 3. Retrieve all Tasks partitioned into Active, Archived, Completed, and Deleted
adminTasks.get('/tasks', async (c) => {
  try {
    const pool = getDbPool(c.env.DATABASE_URL);

    const tasksList = await pool.query(
      `SELECT t.id, t.platform, t.target_subreddit, t.url, t.client_request, t.quota, COALESCE(NULLIF(t.original_quota, 0), NULLIF(t.quota, 0), 1) as original_quota,
              t.price, t.deadline, t.min_rank_id, ar.rank_name as min_rank_name, ar.cqm_level as min_rank_cqm, ar.rank_level as min_rank_level,
              t.deleted_at, t.is_archived, t.created_at, t.updated_at,
              u.email as assigned_to_email,
              (SELECT COUNT(*)::int FROM user_tasks ut WHERE ut.task_id = t.id AND ut.status_id = 'incomplete') as count_incomplete,
              (SELECT COUNT(*)::int FROM user_tasks ut WHERE ut.task_id = t.id AND ut.status_id = 'pending') as count_pending,
              (SELECT COUNT(*)::int FROM user_tasks ut WHERE ut.task_id = t.id AND ut.status_id = 'success') as count_success,
              (SELECT COUNT(*)::int FROM user_tasks ut WHERE ut.task_id = t.id AND ut.status_id = 'paid') as count_paid,
              (SELECT COUNT(*)::int FROM user_tasks ut WHERE ut.task_id = t.id AND ut.status_id = 'failed') as count_failed
       FROM tasks t
       LEFT JOIN account_ranks ar ON t.min_rank_id = ar.id
       LEFT JOIN users u ON t.assigned_to = u.id
       ORDER BY t.created_at DESC`
    );

    const activeTasks: any[] = [];
    const archivedTasks: any[] = [];
    const completedTasks: any[] = [];
    const deletedTasks: any[] = [];
    const now = new Date();

    for (const task of tasksList.rows) {
      const origQuota = (typeof task.original_quota === 'number' && task.original_quota > 0)
        ? task.original_quota
        : ((typeof task.quota === 'number' && task.quota > 0) ? task.quota : 1);
      const isDeleted = task.deleted_at !== null && task.deleted_at !== undefined;
      const isArchived = task.is_archived === true;
      const isDeadlineUp = task.deadline ? new Date(task.deadline) <= now : false;
      const countActive = (task.count_incomplete || 0) + (task.count_pending || 0);
      const countDone = (task.count_success || 0) + (task.count_paid || 0);
      const isQuotaDepleted = task.quota === 0 && countActive === 0;
      const maxFailThreshold = 3 * origQuota;
      const isFailedMax = (task.count_failed || 0) >= maxFailThreshold;

      if (isDeleted) {
        deletedTasks.push({
          ...task,
          original_quota: origQuota,
          is_deleted: true,
          is_archived: isArchived,
        });
      } else if (isArchived) {
        archivedTasks.push({
          ...task,
          original_quota: origQuota,
          is_archived: true,
          is_deleted: false,
        });
      } else if (isDeadlineUp || isQuotaDepleted || isFailedMax) {
        let reason = '';
        if (isDeadlineUp) {
          reason = 'Deadline Passed';
        } else if (isFailedMax) {
          reason = `Excessive Failures (${task.count_failed}/${maxFailThreshold} Max Failures)`;
        } else if (isQuotaDepleted) {
          reason = `Quota Depleted (${countDone}/${origQuota} Completed)`;
        }

        completedTasks.push({
          ...task,
          original_quota: origQuota,
          is_completed: true,
          is_archived: false,
          is_deleted: false,
          archive_reason: reason,
        });
      } else {
        activeTasks.push({
          ...task,
          original_quota: origQuota,
          is_archived: false,
          is_deleted: false,
        });
      }
    }

    return c.json({
      tasks: activeTasks,
      archivedTasks,
      completedTasks,
      deletedTasks,
      allTasks: tasksList.rows,
    });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin fetch tasks error');
    return c.json(body, status);
  }
});

// 4. Update a Task configuration
adminTasks.put('/tasks/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    if (!body || !body.url || !body.clientRequest || body.quota === undefined || !body.price) {
      throw new BusinessError('MISSING_FIELD', 'URL, clientRequest, quota, and price are required');
    }

    const { url, clientRequest, quota, originalQuota, assignedTo, price, deadline, minRankId, min_rank_id, restore, isArchived, is_archived } = body;
    const targetMinRankId = minRankId || min_rank_id || null;
    const platform = (body.platform || 'REDDIT').toUpperCase() as 'REDDIT' | 'PRODUCTHUNT';
    let targetSubreddit = body.target_subreddit || body.subreddit || null;

    if (platform === 'REDDIT' && url) {
      const match = url.match(/\/r\/([a-zA-Z0-9_]+)/i);
      if (match) {
        targetSubreddit = match[1];
      }
    }

    if (targetSubreddit) {
      validateStringField(targetSubreddit, 'Target subreddit', 200);
    }
    validateStringField(url, 'URL', 2000);
    validateStringField(clientRequest, 'Client request', 5000);
    if (targetMinRankId) {
      validateStringField(targetMinRankId, 'Minimum Rank ID', 50);
    }

    if (typeof quota !== 'number' || !Number.isInteger(quota) || quota < 0) {
      throw new BusinessError('INVALID_INPUT', 'Quota must be a non-negative integer');
    }
    if (typeof price !== 'number' || price <= 0) {
      throw new BusinessError('INVALID_INPUT', 'Price must be a positive number');
    }

    try {
      new URL(url);
    } catch {
      throw new BusinessError('INVALID_INPUT', 'URL must be a valid URL');
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    const taskCheck = await pool.query('SELECT id, deleted_at, is_archived FROM tasks WHERE id = $1', [id]);
    if (taskCheck.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'Task not found');
    }
    if (taskCheck.rows[0].deleted_at) {
      throw new BusinessError('CANNOT_EDIT', 'Deleted tasks cannot be edited.');
    }

    const resolvedAssignedTo = await resolveUserId(pool, assignedTo);

    if (targetMinRankId) {
      const rankCheck = await pool.query('SELECT 1 FROM account_ranks WHERE id = $1 LIMIT 1', [targetMinRankId]);
      if (rankCheck.rows.length === 0) {
        throw new BusinessError('INVALID_INPUT', 'Invalid minimum rank ID');
      }
    }

    const targetTotalQuota = typeof originalQuota === 'number' && originalQuota > 0 
      ? originalQuota 
      : (typeof quota === 'number' && quota > 0 ? quota : 1);

    let telegramResult = { notified: false, reason: 'Task updated without restoring' };
    let restoreSql = '';

    if (restore) {
      restoreSql = `, is_archived = FALSE, deadline = CASE WHEN deadline IS NOT NULL AND deadline <= NOW() THEN NULL ELSE deadline END`;
      telegramResult = await checkAndNotifyTelegramTaskCreated(pool, c.env, 1);
    } else if (isArchived !== undefined || is_archived !== undefined) {
      const targetArchived = isArchived !== undefined ? Boolean(isArchived) : Boolean(is_archived);
      restoreSql = `, is_archived = ${targetArchived ? 'TRUE' : 'FALSE'}`;
    }

    const result = await pool.query(
      `UPDATE tasks 
       SET platform = $1,
           target_subreddit = $2, 
           url = $3, 
           client_request = $4, 
           quota = GREATEST(0, $5 - (
             SELECT COUNT(*)::int 
             FROM user_tasks 
             WHERE task_id = tasks.id AND status_id IN ('incomplete', 'pending', 'success', 'paid')
           )), 
           original_quota = GREATEST(
             $5, 
             (SELECT COUNT(*)::int FROM user_tasks WHERE task_id = tasks.id AND status_id IN ('incomplete', 'pending', 'success', 'paid'))
           ),
           assigned_to = $6, 
           price = $7, 
           deadline = $8, 
           min_rank_id = $9, 
           updated_at = NOW() ${restoreSql}
       WHERE id = $10 
       RETURNING *`,
      [platform, targetSubreddit || null, url, clientRequest, targetTotalQuota, resolvedAssignedTo, price, deadline || null, targetMinRankId, id]
    );

    if (result.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'Task not found');
    }

    return c.json({
      success: true,
      task: result.rows[0],
      telegramNotified: telegramResult.notified,
      telegramReason: telegramResult.reason
    });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin update task error');
    return c.json(body, status);
  }
});

// 5. Explicitly Archive a Task
adminTasks.post('/tasks/:id/archive', async (c) => {
  try {
    const id = c.req.param('id');
    const pool = getDbPool(c.env.DATABASE_URL);

    const taskCheck = await pool.query('SELECT id, deleted_at, is_archived FROM tasks WHERE id = $1', [id]);
    if (taskCheck.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'Task not found');
    }
    if (taskCheck.rows[0].deleted_at) {
      throw new BusinessError('CANNOT_ARCHIVE', 'Deleted tasks cannot be archived.');
    }

    const result = await pool.query(
      `UPDATE tasks 
       SET is_archived = TRUE, updated_at = NOW() 
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [id]
    );

    return c.json({
      success: true,
      message: 'Task moved to Archived successfully',
      task: result.rows[0],
    });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin archive task error');
    return c.json(body, status);
  }
});

// 6. Restore / Un-archive a Task (moves from Archived to Active)
adminTasks.post('/tasks/:id/restore', async (c) => {
  try {
    const id = c.req.param('id');
    const pool = getDbPool(c.env.DATABASE_URL);

    const taskCheck = await pool.query('SELECT id, deleted_at, is_archived FROM tasks WHERE id = $1', [id]);
    if (taskCheck.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'Task not found');
    }
    if (taskCheck.rows[0].deleted_at) {
      throw new BusinessError('CANNOT_RESTORE', 'Deleted tasks cannot be restored.');
    }

    // Check Telegram notification cooldown (12h since latest task) BEFORE restoring task
    const telegramResult = await checkAndNotifyTelegramTaskCreated(pool, c.env, 1);

    // Unarchive: set is_archived = FALSE, ensure quota >= 1, clear passed deadline
    const result = await pool.query(
      `UPDATE tasks 
       SET is_archived = FALSE, 
           quota = CASE 
             WHEN quota = 0 THEN 1 
             ELSE quota 
           END,
           original_quota = GREATEST(
             COALESCE(NULLIF(original_quota, 0), 1),
             (SELECT COUNT(*)::int FROM user_tasks WHERE task_id = tasks.id AND status_id IN ('incomplete', 'pending', 'success', 'paid')) + (CASE WHEN quota = 0 THEN 1 ELSE quota END)
           ),
           deadline = CASE WHEN deadline IS NOT NULL AND deadline <= NOW() THEN NULL ELSE deadline END,
           updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'Task not found');
    }

    return c.json({
      success: true,
      message: 'Task restored to Active status successfully',
      task: result.rows[0],
      telegramNotified: telegramResult.notified,
      telegramReason: telegramResult.reason
    });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin restore task error');
    return c.json(body, status);
  }
});

// 7. Delete a Task (Soft Delete -> populates deleted_at, irreversible on site)
adminTasks.delete('/tasks/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const pool = getDbPool(c.env.DATABASE_URL);

    const taskCheck = await pool.query('SELECT id, deleted_at FROM tasks WHERE id = $1', [id]);
    if (taskCheck.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'Task not found');
    }

    if (taskCheck.rows[0].deleted_at) {
      return c.json({ success: true, message: 'Task is already deleted' });
    }

    await pool.query(
      `UPDATE tasks SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    );

    return c.json({
      success: true,
      message: 'Task deleted successfully'
    });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin delete task error');
    return c.json(body, status);
  }
});

// 7. Retrieve complete Tasking History across all users for Admin
adminTasks.get('/tasks/history', async (c) => {
  try {
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

    const whereClauses: string[] = [];
    const queryParams: any[] = [];
    let paramIdx = 1;

    if (statusFilter.length > 0) {
      whereClauses.push(`ut.status_id = ANY($${paramIdx})`);
      queryParams.push(statusFilter);
      paramIdx++;
    }

    if (search) {
      whereClauses.push(
        `(u.email ILIKE $${paramIdx} OR u.reddit ILIKE $${paramIdx} OR u.nickname ILIKE $${paramIdx} OR t.target_subreddit ILIKE $${paramIdx} OR t.client_request ILIKE $${paramIdx} OR ut.reply_url ILIKE $${paramIdx})`
      );
      queryParams.push(`%${search}%`);
      paramIdx++;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const historyQuery = `
      SELECT ut.id as booking_id, ut.status_id, ut.reply_url, ut.note, ut.admin_note,
             ut.created_at, ut.updated_at,
             u.id as user_id, u.email as user_email, u.reddit as user_reddit, u.nickname as user_nickname,
             t.id as task_id, t.platform, t.target_subreddit, t.url as task_url, t.client_request, t.price, t.deadline
      FROM user_tasks ut
      JOIN users u ON ut.user_id = u.id
      JOIN tasks t ON ut.task_id = t.id
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
      JOIN users u ON ut.user_id = u.id
      JOIN tasks t ON ut.task_id = t.id
    `;

    const [historyRes, countsRes] = await Promise.all([
      pool.query(historyQuery, queryParams),
      pool.query(statusCountsQuery),
    ]);

    return c.json({
      success: true,
      history: historyRes.rows,
      total: historyRes.rows.length,
      statusCounts: countsRes.rows[0] || { incomplete: 0, pending: 0, success: 0, paid: 0, failed: 0, total: 0 },
    });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin fetch tasking history error');
    return c.json(body, status);
  }
});

export default adminTasks;


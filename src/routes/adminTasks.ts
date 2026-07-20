import { Hono } from 'hono';
import { getDbPool, withTransaction } from '../db/connection';
import { BusinessError, handleRouteError } from '../utils/errors';
import { Env, Variables } from '../types';
import { validateStringField, extractRedditUsername } from '../utils/validation';

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
    if (!body || !body.url || !body.clientRequest || body.quota === undefined || !body.price || !body.typeId) {
      throw new BusinessError('MISSING_FIELD', 'URL, clientRequest, quota, price, and typeId are required');
    }

    const { url, clientRequest, quota, assignedTo, price, deadline, typeId } = body;
    let subreddit = body.subreddit || null;

    if (url) {
      const match = url.match(/\/r\/([a-zA-Z0-9_]+)/i);
      if (match) {
        subreddit = match[1];
      }
    }

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
    const resolvedAssignedTo = await resolveUserId(pool, assignedTo);

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
      subreddit: string | null;
      url: string;
      clientRequest: string;
      quota: number;
      price: number;
      deadline: string | null;
      typeId: string;
    }> = [];

    for (let i = 0; i < tasks.length; i++) {
      const rowNum = i + 1;
      const t = tasks[i];
      if (!t || typeof t !== 'object') {
        throw new BusinessError('INVALID_INPUT', `Task at row ${rowNum} is not a valid object`);
      }

      const { url, clientRequest, deadline, price } = t;

      if (typeof url !== 'string' || url.trim().length === 0) {
        throw new BusinessError('MISSING_FIELD', `Row ${rowNum}: Reddit URL is required`);
      }
      if (url.length > 2000) {
        throw new BusinessError('INVALID_INPUT', `Row ${rowNum}: Reddit URL is too long (max 2000 characters)`);
      }
      try {
        new URL(url);
      } catch {
        throw new BusinessError('INVALID_INPUT', `Row ${rowNum}: Reddit URL must be a valid URL`);
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

      let subreddit: string | null = null;
      const match = url.match(/\/r\/([a-zA-Z0-9_]+)/i);
      if (match) {
        subreddit = match[1];
      }
      if (subreddit && subreddit.length > 200) {
        throw new BusinessError('INVALID_INPUT', `Row ${rowNum}: Subreddit name is too long (max 200 characters)`);
      }

      validatedTasks.push({
        subreddit,
        url,
        clientRequest,
        quota: 1,
        price: parsedPrice,
        deadline: parsedDeadline,
        typeId: 'normal',
      });
    }

    const insertedTasks = await withTransaction(pool, async (client) => {
      const results = [];
      for (const t of validatedTasks) {
        const res = await client.query(
          `INSERT INTO tasks (subreddit, url, client_request, quota, assigned_to, price, deadline, type_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, NOW(), NOW())
           RETURNING *`,
          [t.subreddit, t.url, t.clientRequest, t.quota, t.price, t.deadline, t.typeId]
        );
        results.push(res.rows[0]);
      }
      return results;
    });

    return c.json({ success: true, count: insertedTasks.length, tasks: insertedTasks });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin bulk create tasks error');
    return c.json(body, status);
  }
});

// 3. Retrieve all Tasks with status metrics
adminTasks.get('/tasks', async (c) => {
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

// 4. Update a Task configuration
adminTasks.put('/tasks/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    if (!body || !body.url || !body.clientRequest || body.quota === undefined || !body.price || !body.typeId) {
      throw new BusinessError('MISSING_FIELD', 'URL, clientRequest, quota, price, and typeId are required');
    }

    const { url, clientRequest, quota, assignedTo, price, deadline, typeId } = body;
    let subreddit = body.subreddit || null;

    if (url) {
      const match = url.match(/\/r\/([a-zA-Z0-9_]+)/i);
      if (match) {
        subreddit = match[1];
      }
    }

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
    const resolvedAssignedTo = await resolveUserId(pool, assignedTo);

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

// 5. Delete a Task configuration
adminTasks.delete('/tasks/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const pool = getDbPool(c.env.DATABASE_URL);

    const result = await pool.query(`DELETE FROM tasks WHERE id = $1 RETURNING id`, [id]);

    if (result.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'Task not found');
    }

    return c.json({ success: true, message: 'Task deleted successfully' });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin delete task error');
    return c.json(body, status);
  }
});

export default adminTasks;

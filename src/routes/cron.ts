import { Hono } from 'hono';
import { getDbPool, withTransaction } from '../db/connection';
import { Env } from '../types';

const cron = new Hono<{ Bindings: Env }>();

// Expiration and Deadline cleanup endpoint triggered by Cloudflare Worker Cron
cron.post('/cleanup', async (c) => {
  try {
    // 1. Verify access token to prevent external denial of service
    const cronSecret = c.req.header('x-cron-secret');
    if (!cronSecret || cronSecret !== c.env.CRON_SECRET) {
      return c.json({ error: 'Unauthorized: Invalid cron secret key' }, 401);
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    // Execute queries in a single transaction block for full database safety
    const cleanupSummary = await withTransaction(pool, async (client) => {
      // CTE 1: Expiration of 12-Hour Bookings
      // Deletes user_tasks matching criteria and increments the related task quota
      const expirationResult = await client.query(`
        WITH deleted_tasks AS (
            DELETE FROM user_tasks ut
            USING tasks t
            WHERE ut.task_id = t.id
              AND ut.status_id = 'incomplete'
              AND ut.created_at < NOW() - INTERVAL '12 hours'
              AND t.assigned_to IS NULL
            RETURNING ut.task_id, ut.id as booking_id
        ),
        updated_quotas AS (
            UPDATE tasks t
            SET quota = t.quota + 1, updated_at = NOW()
            FROM deleted_tasks dt
            WHERE t.id = dt.task_id
            RETURNING t.id
        )
        SELECT COUNT(*)::int as count FROM deleted_tasks;
      `);

      const expiredCount = expirationResult.rows[0].count;

      // CTE 2: Hard Deadline Enforcement
      // Set quota to 0 for past-deadline tasks and marks active incomplete bookings as failed
      const deadlineResult = await client.query(`
        WITH closed_tasks AS (
            UPDATE tasks
            SET quota = 0, updated_at = NOW()
            WHERE deadline IS NOT NULL 
              AND deadline <= NOW() 
              AND quota > 0
            RETURNING id
        ),
        failed_tasks AS (
            UPDATE user_tasks ut
            SET status_id = 'failed', updated_at = NOW()
            FROM closed_tasks ct
            WHERE ut.task_id = ct.id 
              AND ut.status_id = 'incomplete'
            RETURNING ut.id
        )
        SELECT 
          (SELECT COUNT(*)::int FROM closed_tasks) as closed_count,
          (SELECT COUNT(*)::int FROM failed_tasks) as failed_count;
      `);

      const closedCount = deadlineResult.rows[0].closed_count;
      const failedCount = deadlineResult.rows[0].failed_count;

      return {
        expiredBookingsDeleted: expiredCount,
        tasksClosedDueToDeadline: closedCount,
        tasksFailedDueToDeadline: failedCount,
      };
    });

    console.log('Task cleanup run completed successfully:', cleanupSummary);
    return c.json({ success: true, summary: cleanupSummary });
  } catch (error: any) {
    console.error('Task cleanup handler failed:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

export default cron;

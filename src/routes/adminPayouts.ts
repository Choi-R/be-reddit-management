import { Hono } from 'hono';
import { getDbPool, withTransaction } from '../db/connection';
import { BusinessError, handleRouteError } from '../utils/errors';
import { Env, Variables } from '../types';

const adminPayouts = new Hono<{ Bindings: Env; Variables: Variables }>();

// Record PayPal payouts (Mark all accumulated 'success' tasks of a user as 'paid')
adminPayouts.post('/payouts', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.userId) {
      throw new BusinessError('MISSING_FIELD', 'User ID (userId) is required');
    }

    const { userId } = body;
    const pool = getDbPool(c.env.DATABASE_URL);

    const updateInfo = await withTransaction(pool, async (client) => {
      const checkRes = await client.query(
        `SELECT 1 FROM user_tasks WHERE user_id = $1 AND status_id = 'success' LIMIT 1`,
        [userId]
      );
      if (checkRes.rows.length === 0) {
        throw new BusinessError('NO_PENDING_EARNINGS', 'User has no pending success tasks to pay.');
      }

      const updateRes = await client.query(
        `UPDATE user_tasks 
         SET status_id = 'paid', updated_at = NOW()
         WHERE user_id = $1 AND status_id = 'success'
         RETURNING id`,
        [userId]
      );

      return { count: updateRes.rows.length };
    });

    return c.json({
      success: true,
      message: `Successfully marked ${updateInfo.count} tasks as Paid.`,
      count: updateInfo.count,
    });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin record payouts transaction error');
    return c.json(body, status);
  }
});

export default adminPayouts;

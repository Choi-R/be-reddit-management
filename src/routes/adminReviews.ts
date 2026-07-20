import { Hono } from 'hono';
import { getDbPool, withTransaction } from '../db/connection';
import { BusinessError, handleRouteError } from '../utils/errors';
import { Env, Variables } from '../types';

const adminReviews = new Hono<{ Bindings: Env; Variables: Variables }>();

// 1. Review a user task submission (Pending -> Success or Failed)
adminReviews.post('/tasks/review', async (c) => {
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

    const { updatedBooking, quotaReturned } = await withTransaction(pool, async (client) => {
      const bookingCheck = await client.query(
        `SELECT task_id FROM user_tasks WHERE id = $1 AND status_id = 'pending' FOR UPDATE`,
        [bookingId]
      );

      if (bookingCheck.rows.length === 0) {
        throw new BusinessError('NOT_FOUND', 'No pending task submission found matching this ID');
      }

      const taskId = bookingCheck.rows[0].task_id;

      const updateResult = await client.query(
        `UPDATE user_tasks 
         SET status_id = $1, note = COALESCE($2, note), updated_at = NOW()
         WHERE id = $3 AND status_id = 'pending'
         RETURNING *`,
        [statusId, note || null, bookingId]
      );

      let returnedQuota = false;
      if (statusId === 'failed') {
        const updateQuotaResult = await client.query(
          `UPDATE tasks 
           SET quota = quota + 1, updated_at = NOW() 
           WHERE id = $1 AND (deadline IS NULL OR deadline > NOW())
           RETURNING id`,
          [taskId]
        );
        returnedQuota = updateQuotaResult.rows.length > 0;
      }

      return {
        updatedBooking: updateResult.rows[0],
        quotaReturned: returnedQuota,
      };
    });

    return c.json({ success: true, booking: updatedBooking, quotaReturned });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin review submission error');
    return c.json(body, status);
  }
});

// 2. Get all pending user task submissions for Admin review
adminReviews.get('/reviews/pending', async (c) => {
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

export default adminReviews;

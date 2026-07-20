import { Hono } from 'hono';
import { getDbPool, withTransaction } from '../db/connection';
import { createPasswordHash } from '../utils/crypto';
import { BusinessError, handleRouteError } from '../utils/errors';
import { Env, Variables } from '../types';
import { sendNewUserNotificationEmail } from '../utils/email';
import { validateEmail, validateStringField, extractRedditUsername } from '../utils/validation';

const adminUsers = new Hono<{ Bindings: Env; Variables: Variables }>();

// 1. Create a Basic User account
adminUsers.post('/users', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.email || !body.password || !body.reddit) {
      throw new BusinessError('MISSING_FIELD', 'Email, password, and reddit username are required');
    }

    const { email, password, paypal, reddit } = body;

    // Validate inputs
    validateEmail(email);
    validateStringField(password, 'Password', 128);
    if (password.length < 8) {
      throw new BusinessError('INVALID_INPUT', 'Password must be at least 8 characters');
    }
    if (paypal) {
      validateEmail(paypal);
    }
    validateStringField(reddit, 'Reddit username', 500);

    const cleanReddit = extractRedditUsername(reddit);
    if (cleanReddit.length === 0 || cleanReddit.length > 100) {
      throw new BusinessError('INVALID_INPUT', 'A valid Reddit username or profile link is required');
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    // Check if user already exists
    const userCheck = await pool.query('SELECT 1 FROM users WHERE email = $1 LIMIT 1', [email]);
    if (userCheck.rows.length > 0) {
      throw new BusinessError('DUPLICATE', 'User with this email already exists');
    }

    const securePassword = await createPasswordHash(password);

    const newUser = await withTransaction(pool, async (client) => {
      const userInsert = await client.query(
        `INSERT INTO users (email, password, paypal, reddit, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id, email, paypal, reddit, created_at`,
        [email, securePassword, paypal || null, cleanReddit]
      );

      const createdUser = userInsert.rows[0];

      await client.query(
        `INSERT INTO user_roles (user_id, role_id, created_at, updated_at)
         VALUES ($1, 'basic', NOW(), NOW())`,
        [createdUser.id]
      );

      return createdUser;
    });

    try {
      await sendNewUserNotificationEmail(email, cleanReddit, c.env);
    } catch (emailError) {
      console.error('Failed to send registration email notification:', emailError);
    }

    return c.json({ success: true, user: newUser });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin create user error');
    return c.json(body, status);
  }
});

// 2. Fetch all Basic users with payout metrics
adminUsers.get('/users', async (c) => {
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
              ) as paid_balance,
              COALESCE(
                (SELECT COUNT(*)::int 
                 FROM user_tasks ut 
                 WHERE ut.user_id = u.id AND ut.status_id IN ('success', 'paid')), 
                 0
              ) as completed_tasks_count,
              COALESCE(
                (SELECT COUNT(*)::int 
                 FROM user_tasks ut 
                 WHERE ut.user_id = u.id AND ut.status_id = 'incomplete'), 
                 0
              ) as active_booking_count,
              COALESCE(
                (SELECT COUNT(*)::int 
                 FROM user_tasks ut 
                 WHERE ut.user_id = u.id AND ut.status_id = 'pending'), 
                 0
              ) as pending_review_count,
              COALESCE(
                (SELECT COUNT(*)::int 
                 FROM user_tasks ut 
                 WHERE ut.user_id = u.id AND ut.status_id = 'failed'), 
                 0
              ) as failed_count
       FROM users u
       WHERE EXISTS (
         SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id IN ('basic', 'bronze', 'silver', 'gold')
       )
       ORDER BY u.email ASC`
    );

    const formattedUsers = usersList.rows.map((row: any) => {
      const completed = row.completed_tasks_count || 0;
      let tier = 'Bronze';
      if (completed >= 15) {
        tier = 'Gold';
      } else if (completed >= 5) {
        tier = 'Silver';
      }

      return {
        id: row.id,
        email: row.email,
        paypal: row.paypal,
        reddit: row.reddit,
        createdAt: row.created_at,
        pendingBalance: parseFloat(row.pending_balance),
        paidBalance: parseFloat(row.paid_balance),
        completedCount: completed,
        activeBookingCount: row.active_booking_count || 0,
        pendingReviewCount: row.pending_review_count || 0,
        failedCount: row.failed_count || 0,
        tier: tier,
      };
    });

    return c.json({ users: formattedUsers });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin fetch users error');
    return c.json(body, status);
  }
});

// 3. Fetch detailed user statistics, active bookings, pending submissions, and activity history
adminUsers.get('/users/:id/detail', async (c) => {
  try {
    const id = c.req.param('id');
    const pool = getDbPool(c.env.DATABASE_URL);

    const userRes = await pool.query(
      `SELECT id, email, paypal, reddit, created_at FROM users WHERE id = $1`,
      [id]
    );
    if (userRes.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'User not found');
    }
    const user = userRes.rows[0];

    const adminCheck = await pool.query(
      `SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id IN ('admin', 'choi') LIMIT 1`,
      [id]
    );
    const isAdmin = adminCheck.rows.length > 0;

    const statusCountsRes = await pool.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN ut.status_id = 'incomplete' THEN 1 ELSE 0 END)::int, 0) as active_booking_count,
         COALESCE(SUM(CASE WHEN ut.status_id = 'pending' THEN 1 ELSE 0 END)::int, 0) as pending_review_count,
         COALESCE(SUM(CASE WHEN ut.status_id = 'success' THEN 1 ELSE 0 END)::int, 0) as success_count,
         COALESCE(SUM(CASE WHEN ut.status_id = 'paid' THEN 1 ELSE 0 END)::int, 0) as paid_count,
         COALESCE(SUM(CASE WHEN ut.status_id = 'failed' THEN 1 ELSE 0 END)::int, 0) as failed_count,
         COALESCE(SUM(CASE WHEN ut.status_id = 'success' THEN t.price ELSE 0 END), 0.00) as pending_balance,
         COALESCE(SUM(CASE WHEN ut.status_id = 'paid' THEN t.price ELSE 0 END), 0.00) as paid_balance
       FROM user_tasks ut
       JOIN tasks t ON ut.task_id = t.id
       WHERE ut.user_id = $1`,
      [id]
    );

    const counts = statusCountsRes.rows[0] || {};
    const activeBookingCount = counts.active_booking_count || 0;
    const pendingReviewCount = counts.pending_review_count || 0;
    const successCount = counts.success_count || 0;
    const paidCount = counts.paid_count || 0;
    const failedCount = counts.failed_count || 0;
    const completedCount = successCount + paidCount;
    const totalAttempted = activeBookingCount + pendingReviewCount + successCount + paidCount + failedCount;
    const pendingBalance = parseFloat(counts.pending_balance || 0);
    const paidBalance = parseFloat(counts.paid_balance || 0);
    const totalBalance = pendingBalance + paidBalance;

    let tier = 'Bronze';
    let bookingLimit = 1;
    if (isAdmin) {
      tier = 'Admin';
      bookingLimit = 99;
    } else if (completedCount >= 15) {
      tier = 'Gold';
      bookingLimit = 3;
    } else if (completedCount >= 5) {
      tier = 'Silver';
      bookingLimit = 2;
    }

    const activeBookingsRes = await pool.query(
      `SELECT ut.id as booking_id, ut.task_id, ut.status_id, ut.created_at, ut.updated_at,
              t.subreddit, t.url, t.client_request, t.price, t.deadline, tt.type_name
       FROM user_tasks ut
       JOIN tasks t ON ut.task_id = t.id
       JOIN task_types tt ON t.type_id = tt.id
       WHERE ut.user_id = $1 AND ut.status_id = 'incomplete'
       ORDER BY ut.created_at DESC`,
      [id]
    );

    const pendingSubmissionsRes = await pool.query(
      `SELECT ut.id as booking_id, ut.task_id, ut.status_id, ut.reply_url, ut.note, ut.created_at, ut.updated_at,
              t.subreddit, t.url, t.client_request, t.price, t.deadline, tt.type_name
       FROM user_tasks ut
       JOIN tasks t ON ut.task_id = t.id
       JOIN task_types tt ON t.type_id = tt.id
       WHERE ut.user_id = $1 AND ut.status_id = 'pending'
       ORDER BY ut.updated_at DESC`,
      [id]
    );

    const taskHistoryRes = await pool.query(
      `SELECT ut.id as booking_id, ut.task_id, ut.status_id, ut.reply_url, ut.note, ut.created_at, ut.updated_at,
              t.subreddit, t.url, t.client_request, t.price, t.deadline, tt.type_name
       FROM user_tasks ut
       JOIN tasks t ON ut.task_id = t.id
       JOIN task_types tt ON t.type_id = tt.id
       WHERE ut.user_id = $1
       ORDER BY ut.updated_at DESC
       LIMIT 50`,
      [id]
    );

    return c.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          paypal: user.paypal,
          reddit: user.reddit,
          createdAt: user.created_at,
          tier,
          bookingLimit,
        },
        metrics: {
          activeBookingCount,
          pendingReviewCount,
          successCount,
          paidCount,
          failedCount,
          completedCount,
          totalAttempted,
          pendingBalance,
          paidBalance,
          totalBalance,
        },
        activeBookings: activeBookingsRes.rows,
        pendingSubmissions: pendingSubmissionsRes.rows,
        taskHistory: taskHistoryRes.rows,
      },
    });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin fetch user detail error');
    return c.json(body, status);
  }
});

// 4. Update a Basic User account (Profile Info Only)
adminUsers.put('/users/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    if (!body || !body.email || !body.reddit) {
      throw new BusinessError('MISSING_FIELD', 'Email and Reddit username/link are required');
    }

    const { email, paypal, reddit } = body;

    validateEmail(email);
    if (paypal) {
      validateEmail(paypal);
    }
    validateStringField(reddit, 'Reddit username', 500);

    const cleanReddit = extractRedditUsername(reddit);
    if (cleanReddit.length === 0 || cleanReddit.length > 100) {
      throw new BusinessError('INVALID_INPUT', 'A valid Reddit username or profile link is required');
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    const userCheck = await pool.query('SELECT email FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'User not found');
    }

    const emailCheck = await pool.query('SELECT 1 FROM users WHERE email = $1 AND id <> $2 LIMIT 1', [email, id]);
    if (emailCheck.rows.length > 0) {
      throw new BusinessError('DUPLICATE', 'User with this email already exists');
    }

    const query = `UPDATE users 
             SET email = $1, paypal = $2, reddit = $3, updated_at = NOW() 
             WHERE id = $4 
             RETURNING id, email, paypal, reddit, created_at`;
    const params = [email, paypal || null, cleanReddit, id];

    const result = await pool.query(query, params);
    return c.json({ success: true, user: result.rows[0] });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin update user profile error');
    return c.json(body, status);
  }
});

// 5. Reset/Update User Password
adminUsers.put('/users/:id/password', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    if (!body || !body.password) {
      throw new BusinessError('MISSING_FIELD', 'Password is required');
    }

    const { password } = body;

    validateStringField(password, 'Password', 128);
    if (password.length < 8) {
      throw new BusinessError('INVALID_INPUT', 'Password must be at least 8 characters');
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    const userCheck = await pool.query('SELECT 1 FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'User not found');
    }

    const securePassword = await createPasswordHash(password);

    await pool.query(
      `UPDATE users 
       SET password = $1, updated_at = NOW() 
       WHERE id = $2`,
      [securePassword, id]
    );

    return c.json({ success: true, message: 'Password updated successfully' });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin update user password error');
    return c.json(body, status);
  }
});

// 6. Delete a Basic User account
adminUsers.delete('/users/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const currentUser = c.get('user');

    if (currentUser && currentUser.id === id) {
      throw new BusinessError('INVALID_OPERATION', 'You cannot delete your own admin account');
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    const userCheck = await pool.query('SELECT 1 FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'User not found');
    }

    await pool.query('DELETE FROM users WHERE id = $1', [id]);

    return c.json({ success: true, message: 'User deleted successfully' });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin delete user error');
    return c.json(body, status);
  }
});

export default adminUsers;

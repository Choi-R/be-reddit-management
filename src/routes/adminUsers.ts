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

    const { email, password, paypal, reddit, nickname, rankId, rank_id } = body;
    const targetRankId = rankId || rank_id || 'D';

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
    if (nickname) {
      validateStringField(nickname, 'Nickname', 255);
    }

    const cleanReddit = extractRedditUsername(reddit);
    if (cleanReddit.length === 0 || cleanReddit.length > 100) {
      throw new BusinessError('INVALID_INPUT', 'A valid Reddit username or profile link is required');
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    // Validate rankId exists
    const rankCheck = await pool.query('SELECT 1 FROM account_ranks WHERE id = $1 LIMIT 1', [targetRankId]);
    if (rankCheck.rows.length === 0) {
      throw new BusinessError('INVALID_INPUT', 'Invalid account rank ID');
    }

    // Check if user already exists
    const userCheck = await pool.query('SELECT 1 FROM users WHERE email = $1 LIMIT 1', [email]);
    if (userCheck.rows.length > 0) {
      throw new BusinessError('DUPLICATE', 'User with this email already exists');
    }

    const securePassword = await createPasswordHash(password);

    const newUser = await pool.query(
      `INSERT INTO users (email, password, reddit, nickname, role_id, rank_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'basic', $5, NOW(), NOW())
       RETURNING id, email, reddit, nickname, role_id, rank_id, created_at`,
      [email, securePassword, cleanReddit, nickname || null, targetRankId]
    );

    const createdUser = newUser.rows[0];
    // If legacy paypal provided, store in payment_info
    if (paypal) {
      await pool.query(
        `INSERT INTO payment_info (user_id, type, account_details, created_at, updated_at)
         VALUES ($1, 'paypal', $2::jsonb, NOW(), NOW())`,
        [createdUser.id, JSON.stringify({ username: paypal })]
      );
    }

    try {
      await sendNewUserNotificationEmail(email, cleanReddit, c.env);
    } catch (emailError) {
      console.error('Failed to send registration email notification:', emailError);
    }

    // Return created user including payment_info
    const createdUserRes = await pool.query(
      `SELECT u.id, u.email,
              (SELECT pi.account_details->>'username' FROM payment_info pi WHERE pi.user_id = u.id AND pi.type = 'paypal' LIMIT 1) as paypal,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', pi.id, 'type', pi.type, 'account_details', pi.account_details)) FILTER (WHERE pi.id IS NOT NULL), '[]'::jsonb) FROM payment_info pi WHERE pi.user_id = u.id) as payment_info,
              u.reddit, u.nickname, u.role_id, u.rank_id, u.created_at
       FROM users u WHERE u.id = $1`,
      [createdUser.id]
    );

    return c.json({ success: true, user: createdUserRes.rows[0] });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin create user error');
    return c.json(body, status);
  }
});

// 2. Fetch all Basic users with payout metrics and rank info (supports search, sort, cqs filter)
adminUsers.get('/users', async (c) => {
  try {
    const search = (c.req.query('search') || c.req.query('q') || '').trim();
    const cqs = (c.req.query('cqs') || c.req.query('rankId') || c.req.query('rank') || '').trim().toUpperCase();
    const sortBy = (c.req.query('sortBy') || c.req.query('sort_by') || '').trim().toLowerCase();
    const sortOrder = (c.req.query('sortOrder') || c.req.query('order') || '').trim().toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const pool = getDbPool(c.env.DATABASE_URL);

    let queryText = `
      SELECT u.id, u.email,
             (SELECT pi.account_details->>'username' FROM payment_info pi WHERE pi.user_id = u.id AND pi.type = 'paypal' LIMIT 1) as paypal,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', pi.id, 'type', pi.type, 'account_details', pi.account_details)) FILTER (WHERE pi.id IS NOT NULL), '[]'::jsonb) FROM payment_info pi WHERE pi.user_id = u.id) as payment_info,
             u.reddit, u.nickname, u.role_id, u.rank_id,
             ar.rank_name, ar.cqm_level, ar.rank_level, u.created_at,
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
      LEFT JOIN account_ranks ar ON u.rank_id = ar.id
      WHERE 1=1
    `;

    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      queryText += ` AND (u.nickname ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex} OR u.reddit ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (cqs && cqs !== 'ALL') {
      queryText += ` AND UPPER(u.rank_id) = $${paramIndex}`;
      params.push(cqs);
      paramIndex++;
    }

    let orderByClause = `ORDER BY u.email ASC`;
    if (sortBy === 'cqs' || sortBy === 'rank') {
      orderByClause = `ORDER BY COALESCE(ar.rank_level, 1) ${sortOrder}, LOWER(u.email) ASC`;
    } else if (sortBy === 'jointime' || sortBy === 'created_at' || sortBy === 'createdat') {
      orderByClause = `ORDER BY u.created_at ${sortOrder}`;
    } else if (sortBy === 'abc' || sortBy === 'alphabetical') {
      orderByClause = `ORDER BY LOWER(COALESCE(NULLIF(u.nickname, ''), u.reddit, u.email)) ${sortOrder}`;
    }

    queryText += ` ${orderByClause}`;

    const usersList = await pool.query(queryText, params);

    const formattedUsers = usersList.rows.map((row: any) => ({
      id: row.id,
      email: row.email,
      paypal: row.paypal || null,
      paymentInfo: row.payment_info || [],
      reddit: row.reddit,
      nickname: row.nickname,
      roleId: row.role_id,
      rankId: row.rank_id || 'D',
      rankName: row.rank_name || 'Rank D',
      cqmLevel: row.cqm_level || 'Lowest',
      rankLevel: typeof row.rank_level === 'number' ? row.rank_level : 1,
      createdAt: row.created_at,
      pendingBalance: parseFloat(row.pending_balance),
      paidBalance: parseFloat(row.paid_balance),
      completedCount: row.completed_tasks_count || 0,
      activeBookingCount: row.active_booking_count || 0,
      pendingReviewCount: row.pending_review_count || 0,
      failedCount: row.failed_count || 0,
    }));

    return c.json({ users: formattedUsers });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin fetch users error');
    return c.json(body, status);
  }
});

// 2b. Search users by email, reddit username, or nickname (regex support, min 3 chars, max 5 results)
adminUsers.get('/users/search', async (c) => {
  try {
    const q = (c.req.query('q') || '').trim();
    if (q.length < 3) {
      return c.json({ users: [] });
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    let isRegexValid = true;
    try {
      new RegExp(q);
    } catch {
      isRegexValid = false;
    }

    let queryText = `
      SELECT u.id, u.email,
             (SELECT pi.account_details->>'username' FROM payment_info pi WHERE pi.user_id = u.id AND pi.type = 'paypal' LIMIT 1) as paypal,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', pi.id, 'type', pi.type, 'account_details', pi.account_details)) FILTER (WHERE pi.id IS NOT NULL), '[]'::jsonb) FROM payment_info pi WHERE pi.user_id = u.id) as payment_info,
             u.reddit, u.nickname, u.role_id, u.rank_id, ar.rank_name, u.created_at
      FROM users u
      LEFT JOIN account_ranks ar ON u.rank_id = ar.id
      WHERE 1=1
    `;

    let queryParams: any[] = [];
    if (isRegexValid) {
      queryText += ` AND (u.email ~* $1 OR u.reddit ~* $1 OR u.nickname ~* $1)`;
      queryParams.push(q);
    } else {
      queryText += ` AND (u.email ILIKE $1 OR u.reddit ILIKE $1 OR u.nickname ILIKE $1)`;
      queryParams.push(`%${q}%`);
    }

    queryText += ` ORDER BY u.email ASC LIMIT 5`;

    const usersList = await pool.query(queryText, queryParams);

    const formattedUsers = usersList.rows.map((row: any) => ({
      id: row.id,
      email: row.email,
      paypal: row.paypal || null,
      paymentInfo: row.payment_info || [],
      reddit: row.reddit,
      nickname: row.nickname,
      rankId: row.rank_id || 'D',
      rankName: row.rank_name || 'Rank D',
      createdAt: row.created_at,
    }));

    return c.json({ users: formattedUsers });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin search users error');
    return c.json(body, status);
  }
});

// 3. Fetch detailed user statistics, active bookings, pending submissions, and activity history
adminUsers.get('/users/:id/detail', async (c) => {
  try {
    const id = c.req.param('id');
    const pool = getDbPool(c.env.DATABASE_URL);

    const userRes = await pool.query(
      `SELECT u.id, u.email,
              (SELECT pi.account_details->>'username' FROM payment_info pi WHERE pi.user_id = u.id AND pi.type = 'paypal' LIMIT 1) as paypal,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', pi.id, 'type', pi.type, 'account_details', pi.account_details)) FILTER (WHERE pi.id IS NOT NULL), '[]'::jsonb) FROM payment_info pi WHERE pi.user_id = u.id) as payment_info,
              u.reddit, u.nickname, u.role_id, u.rank_id,
              ar.rank_name, ar.cqm_level, ar.rank_level, u.created_at,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', ph.id, 'user_id', ph.user_id, 'username', ph.username, 'headline', ph.headline, 'bio', ph.bio, 'created_at', ph.created_at, 'updated_at', ph.updated_at)) FILTER (WHERE ph.id IS NOT NULL), '[]'::jsonb)
               FROM producthunt_accounts ph WHERE ph.user_id = u.id) as producthunt_accounts
       FROM users u
       LEFT JOIN account_ranks ar ON u.rank_id = ar.id
       WHERE u.id = $1`,
      [id]
    );
    if (userRes.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'User not found');
    }
    const user = userRes.rows[0];

    const isAdmin = user.role_id === 'admin' || user.role_id === 'choi';

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

    const bookingLimit = isAdmin ? 99 : 1;
    const accountRank = {
      id: user.rank_id || 'D',
      rank_name: user.rank_name || 'Rank D',
      cqm_level: user.cqm_level || 'Lowest',
      rank_level: typeof user.rank_level === 'number' ? user.rank_level : 1,
    };

    const activeBookingsRes = await pool.query(
      `SELECT ut.id as booking_id, ut.task_id, ut.status_id, ut.created_at, ut.updated_at,
              t.platform, t.target_subreddit, t.url, t.client_request, t.price, t.deadline, t.min_rank_id, ar.rank_name as min_rank_name
       FROM user_tasks ut
       JOIN tasks t ON ut.task_id = t.id
       LEFT JOIN account_ranks ar ON t.min_rank_id = ar.id
       WHERE ut.user_id = $1 AND ut.status_id = 'incomplete'
       ORDER BY ut.created_at DESC`,
      [id]
    );

    const pendingSubmissionsRes = await pool.query(
      `SELECT ut.id as booking_id, ut.task_id, ut.status_id, ut.reply_url, ut.note, ut.created_at, ut.updated_at,
              t.platform, t.target_subreddit, t.url, t.client_request, t.price, t.deadline, t.min_rank_id, ar.rank_name as min_rank_name
       FROM user_tasks ut
       JOIN tasks t ON ut.task_id = t.id
       LEFT JOIN account_ranks ar ON t.min_rank_id = ar.id
       WHERE ut.user_id = $1 AND ut.status_id = 'pending'
       ORDER BY ut.updated_at DESC`,
      [id]
    );

    const taskHistoryRes = await pool.query(
      `SELECT ut.id as booking_id, ut.task_id, ut.status_id, ut.reply_url, ut.note, ut.admin_note, ut.created_at, ut.updated_at,
              t.platform, t.target_subreddit, t.url, t.client_request, t.price, t.deadline, t.min_rank_id, ar.rank_name as min_rank_name
       FROM user_tasks ut
       JOIN tasks t ON ut.task_id = t.id
       LEFT JOIN account_ranks ar ON t.min_rank_id = ar.id
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
          paypal: user.paypal || null,
          paymentInfo: user.payment_info || [],
          reddit: user.reddit,
          nickname: user.nickname,
          roleId: user.role_id,
          createdAt: user.created_at,
          rankId: accountRank.id,
          rankName: accountRank.rank_name,
          cqmLevel: accountRank.cqm_level,
          rankLevel: accountRank.rank_level,
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

// 4. Update a User account profile and rank
adminUsers.put('/users/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    if (!body || !body.email || !body.reddit) {
      throw new BusinessError('MISSING_FIELD', 'Email and Reddit username/link are required');
    }

    const { email, paypal, reddit, nickname, rankId, rank_id } = body;
    const targetRankId = rankId || rank_id || null;

    validateEmail(email);
    if (paypal) {
      validateEmail(paypal);
    }
    validateStringField(reddit, 'Reddit username', 500);
    if (nickname) {
      validateStringField(nickname, 'Nickname', 255);
    }

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

    if (targetRankId) {
      const rankCheck = await pool.query('SELECT 1 FROM account_ranks WHERE id = $1 LIMIT 1', [targetRankId]);
      if (rankCheck.rows.length === 0) {
        throw new BusinessError('INVALID_INPUT', 'Invalid account rank ID');
      }
    }

    const query = `UPDATE users 
             SET email = $1, reddit = $2, nickname = $3,
                 rank_id = COALESCE($4, rank_id), updated_at = NOW() 
             WHERE id = $5 
             RETURNING id, email, reddit, nickname, role_id, rank_id, created_at`;
    const params = [email, cleanReddit, nickname || null, targetRankId, id];

    const result = await pool.query(query, params);

    // Handle payment info updates
    if (Array.isArray(body.paymentInfo)) {
      // Replace all existing payment_info rows for this user with provided entries
      await pool.query('DELETE FROM payment_info WHERE user_id = $1', [id]);
      for (const entry of body.paymentInfo) {
        if (!entry || !entry.type || !entry.account_details) continue;
        await pool.query(
          `INSERT INTO payment_info (user_id, type, account_details, created_at, updated_at)
           VALUES ($1, $2::payment_type, $3::jsonb, NOW(), NOW())`,
          [id, entry.type, JSON.stringify(entry.account_details)]
        );
      }
    } else if (paypal) {
      // Legacy single paypal field: upsert into payment_info
      await pool.query(`DELETE FROM payment_info WHERE user_id = $1 AND type = 'paypal'`, [id]);
      await pool.query(
        `INSERT INTO payment_info (user_id, type, account_details, created_at, updated_at)
         VALUES ($1, 'paypal', $2::jsonb, NOW(), NOW())`,
        [id, JSON.stringify({ username: paypal })]
      );
    }

    // Return updated user including payment_info
    const updatedUserRes = await pool.query(
      `SELECT u.id, u.email,
              (SELECT pi.account_details->>'username' FROM payment_info pi WHERE pi.user_id = u.id AND pi.type = 'paypal' LIMIT 1) as paypal,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', pi.id, 'type', pi.type, 'account_details', pi.account_details)) FILTER (WHERE pi.id IS NOT NULL), '[]'::jsonb) FROM payment_info pi WHERE pi.user_id = u.id) as payment_info,
              u.reddit, u.nickname, u.role_id, u.rank_id, u.created_at
       FROM users u WHERE u.id = $1`,
      [id]
    );

    return c.json({ success: true, user: updatedUserRes.rows[0] });
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

// 7. Create a ProductHunt account for a user
adminUsers.post('/users/:userId/producthunt-accounts', async (c) => {
  try {
    const userId = c.req.param('userId');
    const body = await c.req.json().catch(() => null);
    if (!body || !body.username) {
      throw new BusinessError('MISSING_FIELD', 'Username is required');
    }

    const { username, headline, bio } = body;

    const pool = getDbPool(c.env.DATABASE_URL);

    const userCheck = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'User not found');
    }

    const result = await pool.query(
      `INSERT INTO producthunt_accounts (user_id, username, headline, bio, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING *`,
      [userId, username, headline || null, bio || null]
    );

    return c.json({ success: true, account: result.rows[0] });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin create PH account error');
    return c.json(body, status);
  }
});

// 8. List ProductHunt accounts for a user
adminUsers.get('/users/:userId/producthunt-accounts', async (c) => {
  try {
    const userId = c.req.param('userId');
    const pool = getDbPool(c.env.DATABASE_URL);

    const userCheck = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'User not found');
    }

    const result = await pool.query(
      `SELECT * FROM producthunt_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );

    return c.json({ success: true, accounts: result.rows });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin list PH accounts error');
    return c.json(body, status);
  }
});

// 9. Update a ProductHunt account
adminUsers.put('/users/:userId/producthunt-accounts/:phId', async (c) => {
  try {
    const userId = c.req.param('userId');
    const phId = c.req.param('phId');
    const body = await c.req.json().catch(() => null);
    if (!body || !body.username) {
      throw new BusinessError('MISSING_FIELD', 'Username is required');
    }

    const { username, headline, bio } = body;

    const pool = getDbPool(c.env.DATABASE_URL);

    const accountCheck = await pool.query(
      'SELECT 1 FROM producthunt_accounts WHERE id = $1 AND user_id = $2',
      [phId, userId]
    );
    if (accountCheck.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'ProductHunt account not found');
    }

    const result = await pool.query(
      `UPDATE producthunt_accounts 
       SET username = $1, headline = $2, bio = $3, updated_at = NOW()
       WHERE id = $4 AND user_id = $5
       RETURNING *`,
      [username, headline || null, bio || null, phId, userId]
    );

    return c.json({ success: true, account: result.rows[0] });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin update PH account error');
    return c.json(body, status);
  }
});

// 10. Delete a ProductHunt account
adminUsers.delete('/users/:userId/producthunt-accounts/:phId', async (c) => {
  try {
    const userId = c.req.param('userId');
    const phId = c.req.param('phId');
    const pool = getDbPool(c.env.DATABASE_URL);

    const accountCheck = await pool.query(
      'SELECT 1 FROM producthunt_accounts WHERE id = $1 AND user_id = $2',
      [phId, userId]
    );
    if (accountCheck.rows.length === 0) {
      throw new BusinessError('NOT_FOUND', 'ProductHunt account not found');
    }

    await pool.query('DELETE FROM producthunt_accounts WHERE id = $1 AND user_id = $2', [phId, userId]);

    return c.json({ success: true, message: 'ProductHunt account deleted successfully' });
  } catch (error: unknown) {
    const { body, status } = handleRouteError(error, 'Admin delete PH account error');
    return c.json(body, status);
  }
});

export default adminUsers;

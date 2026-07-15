import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { getDbPool } from '../db/connection';
import { verifyPassword, createPasswordHash } from '../utils/crypto';
import { sendResetPasswordEmail } from '../utils/email';
import { Env } from '../types';
import { rateLimiter } from '../middleware/rateLimit';

const auth = new Hono<{ Bindings: Env }>();

auth.post(
  '/login',
  rateLimiter({
    windowMs: 5 * 60 * 1000,
    max: 5,
    message: 'Too many login attempts. Please try again after 5 minutes.'
  }),
  async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.email || !body.password) {
      return c.json({ error: 'Email and password are required' }, 400);
    }

    const { email, password } = body;
    const pool = getDbPool(c.env.DATABASE_URL);

    // 1. Retrieve the user by email
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }
    const user = userResult.rows[0];

    // 2. Validate password using WebCrypto-based salt:hash comparison
    const isPasswordCorrect = await verifyPassword(password, user.password);
    if (!isPasswordCorrect) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    // 3. Retrieve user roles
    const rolesResult = await pool.query('SELECT role_id FROM user_roles WHERE user_id = $1', [user.id]);
    const roles = rolesResult.rows.map((row: any) => row.role_id);

    // 4. Sign standard-compliant JWT token valid for 24 hours
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      id: user.id,
      email: user.email,
      roles: roles,
      iss: 'reddit-crm-api',
      aud: 'reddit-crm-client',
      iat: now,
      exp: now + 60 * 60 * 24,
    };
    const token = await sign(payload, c.env.JWT_SECRET);

    return c.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        paypal: user.paypal,
        reddit: user.reddit,
        roles: roles,
      },
    });
  } catch (error: any) {
    console.error('Auth login handler error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

auth.post(
  '/forgot-password',
  rateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 3,
    message: 'Too many password reset requests. Please try again after 15 minutes.'
  }),
  async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.email) {
      return c.json({ error: 'Email is required' }, 400);
    }

    const { email } = body;
    const pool = getDbPool(c.env.DATABASE_URL);

    // 1. Verify if user exists
    const userResult = await pool.query('SELECT id, email FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      // For security and user privacy, respond with success even if the email does not exist
      return c.json({
        success: true,
        message: 'If the email is registered, a password reset link has been sent.',
      });
    }

    // 2. Generate a cryptographically secure token
    const tokenBytes = new Uint8Array(20);
    crypto.getRandomValues(tokenBytes);
    const token = Array.from(tokenBytes, b => b.toString(16).padStart(2, '0')).join('');

    // 3. Clear existing tokens and insert a new one with 1 hour expiration
    await pool.query('DELETE FROM password_resets WHERE email = $1', [email]);
    await pool.query(
      `INSERT INTO password_resets (email, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
      [email, token]
    );

    // 4. Send the reset password email
    await sendResetPasswordEmail(email, token, c.env);

    return c.json({
      success: true,
      message: 'Password reset link has been sent to your email.',
    });
  } catch (error: any) {
    console.error('Forgot password endpoint error:', error);
    return c.json({ error: error.message || 'Internal Server Error' }, 500);
  }
});

auth.post(
  '/reset-password',
  rateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many password reset attempts. Please try again after 15 minutes.'
  }),
  async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.token || !body.password) {
      return c.json({ error: 'Token and new password are required' }, 400);
    }

    const { token, password } = body;
    if (password.length < 8) {
      return c.json({ error: 'Password must be at least 8 characters long' }, 400);
    }

    const pool = getDbPool(c.env.DATABASE_URL);

    // 1. Retrieve valid token
    const resetResult = await pool.query(
      'SELECT email, expires_at FROM password_resets WHERE token = $1 AND expires_at > NOW()',
      [token]
    );

    if (resetResult.rows.length === 0) {
      return c.json({ error: 'The password reset link is invalid or has expired.' }, 400);
    }

    const { email } = resetResult.rows[0];

    // 2. Generate a new password hash
    const hashedPassword = await createPasswordHash(password);

    // 3. Update password and delete reset tokens inside a transaction
    await pool.query('BEGIN');
    try {
      await pool.query('UPDATE users SET password = $1, updated_at = NOW() WHERE email = $2', [hashedPassword, email]);
      await pool.query('DELETE FROM password_resets WHERE email = $1', [email]);
      await pool.query('COMMIT');
    } catch (dbError) {
      await pool.query('ROLLBACK');
      throw dbError;
    }

    return c.json({
      success: true,
      message: 'Your password has been successfully reset.',
    });
  } catch (error: any) {
    console.error('Reset password endpoint error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

export default auth;

import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { getDbPool } from '../db/connection';
import { verifyPassword } from '../utils/crypto';
import { Env } from '../types';

const auth = new Hono<{ Bindings: Env }>();

auth.post('/login', async (c) => {
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

export default auth;

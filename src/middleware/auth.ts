import { MiddlewareHandler } from 'hono';
import { verify } from 'hono/jwt';
import { UserPayload } from '../types';

// Role-based JWT authentication middleware utilizing Hono's WebCrypto JWT validation
export const authMiddleware = (allowedRoles?: string[]): MiddlewareHandler => async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header. Required format: Bearer <token>' }, 401);
  }

  try {
    const payload = (await verify(authHeader.substring(7), c.env.JWT_SECRET, 'HS256')) as unknown as UserPayload;
    c.set('user', payload);

    if (allowedRoles?.length && !payload.roles.some(r => allowedRoles.includes(r))) {
      return c.json({ error: 'Forbidden: Insufficient permissions' }, 403);
    }

    await next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
};

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import auth from './routes/auth';
import tasks from './routes/tasks';
import admin from './routes/admin';
import cron from './routes/cron';
import { Env } from './types';
import { rateLimiter } from './middleware/rateLimit';

const app = new Hono<{ Bindings: Env }>();

// Block search engine crawlers and AI bots, and set X-Robots-Tag header
const BLOCKED_BOTS_REGEX = /gptbot|chatgpt-user|google-extended|anthropic-ai|claudebot|perplexity|ccbot|cohere-ai|googlebot|bingbot|slurp|duckduckbot|yandexbot|baiduspider|sogou|exabot|facebot|ia_archiver/i;

app.use('*', async (c, next) => {
  const userAgent = c.req.header('User-Agent') || '';
  if (BLOCKED_BOTS_REGEX.test(userAgent)) {
    return c.text('Forbidden: Crawler / Bot access is denied.', 403);
  }
  
  // Set comprehensive Security Headers (Anti-Clickjacking, Anti-XSS, CSP, Robots protection)
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none';");
  await next();
});

// Protect dotfiles and sensitive config paths (.env, .git, etc.)
app.use('*', async (c, next) => {
  const path = c.req.path.toLowerCase();
  if (path.includes('/.') || path.includes('/env') || path.includes('/config') || path.includes('/aws')) {
    return c.json({ error: 'Access Denied', status: 403 }, 403);
  }
  await next();
});

// Enable CORS for frontend integration
app.use('/api/*', cors({
  origin: (origin, c) => {
    const allowed = c.env.FRONTEND_URL || c.env.VITE_FRONTEND_URL || 'https://reddit-management.choi.web.id';
    // Allow the configured frontend origin and localhost for development
    if (origin === allowed || origin?.startsWith('http://localhost')) {
      return origin;
    }
    return null;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-cron-secret'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
}));

// Global API rate limit: Max 60 requests per minute
app.use('/api/*', rateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many API requests. Please try again later.'
}));

// API Routes
app.route('/api/auth', auth);
app.route('/api/tasks', tasks);
app.route('/api/admin', admin);
app.route('/api/cron', cron);

// Base route health check
app.get('/', (c) => c.text('Reddit CRM API Service (Hono Edge)'));

// 404 Handler for undefined routes (Prevents Soft 404 returning 200)
app.notFound((c) => {
  return c.json({ error: 'Endpoint Not Found', status: 404 }, 404);
});

// Centralized error handling (Prevents sensitive internal stack traces from leaking)
app.onError((err, c) => {
  console.error('Unhandled API Error:', err);
  return c.json({ error: 'Internal Server Error', status: 500 }, 500);
});

// Export fetch and scheduled events for Cloudflare Workers
export default {
  fetch: app.fetch,
  
  // Handles the Cloudflare Worker Cron triggers
  async scheduled(event: any, env: Env, ctx: any) {
    console.log(`Cron schedule event triggered: ${event.cron}`);

    // Create an internal request to invoke the cleanup handler locally.
    // By calling app.fetch directly, we run the routing path internally within 
    // the worker container without making an outbound HTTP call.
    const cleanupRequest = new Request('http://localhost/api/cron/cleanup', {
      method: 'POST',
      headers: {
        'x-cron-secret': env.CRON_SECRET,
        'Content-Type': 'application/json'
      }
    });

    // Run background worker cleanup process and monitor logs using an async helper
    const runCleanup = async () => {
      try {
        const res = await app.fetch(cleanupRequest, env);
        const result = await res.json().catch(() => ({}));
        console.log('Hourly database cleanup finished. Result:', JSON.stringify(result));
      } catch (err: any) {
        console.error('Hourly database cleanup failed with error:', err);
      }
    };

    ctx.waitUntil(runCleanup());
  }
};

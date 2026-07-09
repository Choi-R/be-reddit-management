import { Hono } from 'hono';
import { cors } from 'hono/cors';
import auth from './routes/auth';
import tasks from './routes/tasks';
import admin from './routes/admin';
import cron from './routes/cron';
import { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

// Enable CORS for frontend integration
app.use('/api/*', cors({
  origin: '*', // Restrict to front-end domain in production
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-cron-secret'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
}));

// API Routes
app.route('/api/auth', auth);
app.route('/api/tasks', tasks);
app.route('/api/admin', admin);
app.route('/api/cron', cron);

// Base route health check
app.get('/', (c) => c.text('Reddit CRM API Service (Hono Edge)'));

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

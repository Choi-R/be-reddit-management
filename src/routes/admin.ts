import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { Env, Variables } from '../types';
import adminUsers from './adminUsers';
import adminTasks from './adminTasks';
import adminReviews from './adminReviews';
import adminPayouts from './adminPayouts';

const admin = new Hono<{ Bindings: Env; Variables: Variables }>();

// All routes in this module require either 'admin' or 'choi' roles
admin.use('/*', authMiddleware(['admin', 'choi']));

admin.route('/', adminUsers);
admin.route('/', adminTasks);
admin.route('/', adminReviews);
admin.route('/', adminPayouts);

export default admin;

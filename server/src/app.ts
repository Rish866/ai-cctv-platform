import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/http.js';
import { authRouter } from './routes/auth.routes.js';
import { sitesRouter, zonesRouter } from './routes/sites.routes.js';
import { camerasRouter } from './routes/cameras.routes.js';
import { aiRulesRouter } from './routes/airules.routes.js';
import { eventsRouter } from './routes/events.routes.js';
import { notificationsRouter } from './routes/notifications.routes.js';
import { reportsRouter } from './routes/reports.routes.js';
import { billingRouter } from './routes/billing.routes.js';
import { membersRouter } from './routes/members.routes.js';
import { auditRouter, dashboardRouter, searchRouter } from './routes/misc.routes.js';
import { storageRouter, streamsRouter } from './routes/storage.routes.js';
import { platformRouter } from './routes/platform.routes.js';

export function createApp(): Express {
  const app = express();

  // Security headers.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
        },
      },
    }),
  );
  app.set('trust proxy', 1);
  app.use(
    cors({
      origin: config.webOrigin.split(',').map((s) => s.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  // Global rate limit.
  app.use(
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'sentriai', ts: Date.now() }));

  // Stricter limit on auth endpoints (brute-force protection).
  const authLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.authMax,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/signup', authLimiter);
  app.use('/api/auth/forgot-password', authLimiter);

  // Routes.
  app.use('/api/auth', authRouter);
  app.use('/api/sites', sitesRouter);
  app.use('/api/zones', zonesRouter);
  app.use('/api/cameras', camerasRouter);
  app.use('/api/ai-rules', aiRulesRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/members', membersRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/audit-logs', auditRouter);
  app.use('/api/storage', storageRouter);
  app.use('/api/streams', streamsRouter);
  app.use('/api/platform', platformRouter);

  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}

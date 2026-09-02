const fs = require('fs');
const path = require('path');
const dns = require('dns');

// Prioritize IPv4 over IPv6 in cloud containers to prevent ENETUNREACH errors
try {
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (e) {
  // Older Node runtimes may not expose DNS result ordering controls.
}

try {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
  dotenv.config();
} catch (e) {
  // dotenv optional in production where process.env is injected by host
}

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { errorHandler, notFoundHandler } = require('./middleware/errorMiddleware');
const { generalApiLimiter } = require('./middleware/rateLimitMiddleware');

const healthRoutes = require('./routes/healthRoutes');
const authRoutes = require('./routes/authRoutes');
const contactOtpRoutes = require('./routes/contactOtpRoutes');
const biometricRoutes = require('./routes/biometricRoutes');
const accountRoutes = require('./routes/accountRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const securityRoutes = require('./routes/securityRoutes');
const complaintRoutes = require('./routes/complaintRoutes');
const adminRoutes = require('./routes/adminRoutes');
const merchantRoutes = require('./routes/merchantRoutes');

const app = express();
const PORT = Number(process.env.PORT) || 4000;

// Render and other reverse proxies provide the client IP in X-Forwarded-For.
// Trust only the first proxy hop so rate limiting receives a stable IP without
// trusting arbitrary client-supplied forwarding chains.
app.set('trust proxy', 1);

// Multi-path candidate resolution for deployed frontend assets
const candidateFrontendDirs = [
  path.join(__dirname, '..', '..', 'frontend'),
  path.join(process.cwd(), 'frontend'),
  path.join(process.cwd(), 'dist'),
  path.join(process.cwd(), 'build'),
  path.join(__dirname, '..', '..', 'dist'),
  path.join(__dirname, '..', 'frontend'),
  path.join(__dirname, 'frontend'),
];

const FRONTEND_DIR =
  candidateFrontendDirs.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ||
  path.join(__dirname, '..', '..', 'frontend');

// Disable server fingerprinting
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-hashes'",
          "'wasm-unsafe-eval'",
          'https://cdn.jsdelivr.net',
          'https://*.cloud.appwrite.io',
          'https://sfo.cloud.appwrite.io',
          'https://nyc.cloud.appwrite.io',
          'https://*.supabase.co',
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
          'https://cdn.jsdelivr.net',
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: [
          "'self'",
          'http://localhost:*',
          'http://127.0.0.1:*',
          'https://*.cloud.appwrite.io',
          'https://sfo.cloud.appwrite.io',
          'https://nyc.cloud.appwrite.io',
          'https://*.supabase.co',
          'https://cdn.jsdelivr.net',
          'https:',
          'ws:',
          'wss:',
        ],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        workerSrc: ["'self'", 'blob:'],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

// Explicit Security & Permissions Headers & Server Cloaking
app.use((req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), microphone=(), geolocation=(), payment=(self), interest-cohort=()'
  );
  res.removeHeader('Server');
  res.removeHeader('X-Powered-By');
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      const configuredOrigins = (
        process.env.FRONTEND_ORIGINS ||
        process.env.FRONTEND_URL ||
        process.env.CORS_ORIGIN ||
        ''
      )
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value && value !== '*');
      const allowedOrigins =
        configuredOrigins.length > 0
          ? configuredOrigins
          : [
              'https://icash.onrender.com',
              'http://localhost:3000',
              'http://localhost:4000',
              'http://127.0.0.1:5500',
            ];
      const isAllowedOrigin =
        !origin ||
        allowedOrigins.includes(origin) ||
        /^https:\/\/[a-z0-9-]+\.onrender\.com$/i.test(origin) ||
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);

      // Non-browser requests have no Origin header and remain valid.
      if (isAllowedOrigin) {
        return callback(null, true);
      }
      return callback(new Error('Origin is not allowed by CORS.'));
    },
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(generalApiLimiter);

// Health & Probe endpoints (mounted at root and /api for container, proxy, and LB discovery)
const HealthController = require('./controllers/healthController');
app.use('/health', healthRoutes);
app.get('/healthz', HealthController.getLiveness);
app.get('/live', HealthController.getLiveness);
app.get('/ready', HealthController.getReadiness);
app.use('/api/health', healthRoutes);
app.get('/api/healthz', HealthController.getLiveness);
app.get('/api/live', HealthController.getLiveness);
app.get('/api/ready', HealthController.getReadiness);

app.use('/api/auth', authRoutes);
app.use('/api/otp/contact', contactOtpRoutes);
app.use('/api/biometric', biometricRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/complaints', complaintRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/merchant', merchantRoutes);

// Any unmatched /api/* route is a genuine 404, not the SPA fallback.
app.use('/api', notFoundHandler);

// Serve the static frontend (index.html, script.js, style.css, api.js, assets/).
app.use(
  express.static(FRONTEND_DIR, {
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css');
      } else if (filePath.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript');
      } else if (filePath.endsWith('.png')) {
        res.setHeader('Content-Type', 'image/png');
      } else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
        res.setHeader('Content-Type', 'image/jpeg');
      } else if (filePath.endsWith('.svg')) {
        res.setHeader('Content-Type', 'image/svg+xml');
      } else if (filePath.endsWith('.wasm')) {
        res.setHeader('Content-Type', 'application/wasm');
      }
    },
  })
);

// SPA fallback for any other non-API route.
app.get('*', (req, res) => {
  // If a static file asset was requested but not found, return 404 rather than index.html (which breaks MIME checks)
  if (path.extname(req.path)) {
    return res.status(404).send('Asset not found');
  }
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.use(errorHandler);

// Universal entrypoint: supports standalone Node execution, Express middleware, and Appwrite Functions
async function handler(contextOrReq, res, next) {
  // 1. Appwrite Function Context: { req, res, log, error }
  const isAppwriteContext =
    contextOrReq &&
    contextOrReq.req &&
    contextOrReq.res &&
    (typeof contextOrReq.res.json === 'function' ||
      typeof contextOrReq.res.send === 'function' ||
      typeof contextOrReq.res.text === 'function' ||
      typeof contextOrReq.res.empty === 'function');

  if (isAppwriteContext) {
    const { req: appwriteReq, res: appwriteRes } = contextOrReq;
    const reqPath = appwriteReq.path || '/';

    const sendResponse = (body, status = 200, headers = {}) => {
      if (typeof appwriteRes.send === 'function') {
        return appwriteRes.send(body, status, headers);
      }
      if (typeof appwriteRes.text === 'function' && typeof body === 'string') {
        return appwriteRes.text(body, status, headers);
      }
      if (typeof appwriteRes.json === 'function') {
        return appwriteRes.json(
          typeof body === 'string' ? { content: body } : body,
          status,
          headers
        );
      }
    };

    // Health check
    if (
      reqPath === '/api/health' ||
      reqPath === '/health' ||
      reqPath === '/healthz' ||
      reqPath === '/live' ||
      reqPath === '/ready' ||
      reqPath === '/api/ready'
    ) {
      return typeof appwriteRes.json === 'function'
        ? appwriteRes.json({
            ok: true,
            status: 'healthy',
            service: 'icash-backend',
            mode: 'appwrite-function',
            time: new Date().toISOString(),
          })
        : sendResponse('OK', 200);
    }

    // Static assets serving for Appwrite Function
    if (!reqPath.startsWith('/api')) {
      const fs = require('fs');
      const target = reqPath === '/' ? 'index.html' : reqPath.replace(/^\//, '');
      const filePath = path.join(FRONTEND_DIR, target);

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.bin': 'application/octet-stream',
        };
        const mime = mimeTypes[ext] || 'text/plain';
        const isBinary = ext.match(/\.(png|jpg|jpeg|ico|bin|shard\d+)$/);
        const data = fs.readFileSync(filePath, isBinary ? null : 'utf8');
        return sendResponse(data, 200, { 'Content-Type': mime });
      }

      // SPA index fallback
      const indexPath = path.join(FRONTEND_DIR, 'index.html');
      if (fs.existsSync(indexPath)) {
        return sendResponse(fs.readFileSync(indexPath, 'utf8'), 200, {
          'Content-Type': 'text/html; charset=utf-8',
        });
      }
    }

    // Default API response
    return typeof appwriteRes.json === 'function'
      ? appwriteRes.json({
          ok: true,
          service: 'icash-backend',
          message: 'iCash API active on Appwrite Open-Runtimes',
          path: reqPath,
        })
      : sendResponse('iCash API Active', 200);
  }

  // 2. Standard Express middleware / server request
  return app(contextOrReq, res, next);
}

// Attach Express properties onto handler
Object.setPrototypeOf(handler, app);

function autoSyncDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.includes('localhost:5432')) {
    console.log(
      'ℹ️  Using default DATABASE_URL. For persistent cloud storage, provide your PostgreSQL URL (e.g. Supabase or Neon).'
    );
    return;
  }
  try {
    const { execSync } = require('child_process');
    console.log('🔄 Checking database schema with Prisma db push...');
    const prismaBin = path.join(
      __dirname,
      '..',
      '..',
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'prisma.cmd' : 'prisma'
    );
    const cmd = require('fs').existsSync(prismaBin)
      ? `"${prismaBin}" db push --schema=backend/prisma/schema.prisma --skip-generate`
      : 'npx --no-install prisma db push --schema=backend/prisma/schema.prisma --skip-generate';
    execSync(cmd, { stdio: 'inherit', env: process.env });
    console.log('✅ Database schema synchronized.');
  } catch (err) {
    console.warn('⚠️  Database schema sync note:', err.message);
  }
}

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`\n=======================================================`);
    console.log(`🚀 iCash Full-Stack Banking Backend running on: http://localhost:${port}`);
    console.log(`🔒 Security: Argon2/Bcrypt + HTTP-Only Session Cookies`);
    console.log(`🗄️  Database: PostgreSQL with Prisma ORM`);
    console.log(`👁️  Biometrics: Facial Feature Vector Verification Gate`);
    console.log(`=======================================================\n`);

    // Auto sync schema if cloud database is configured
    setTimeout(autoSyncDatabase, 1500);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} is in use, attempting ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });

  return server;
}

if (require.main === module) {
  startServer(PORT);
}

module.exports = handler;
module.exports.app = app;
module.exports.default = handler;

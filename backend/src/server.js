const path = require('path');
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

const authRoutes = require('./routes/authRoutes');
const otpRoutes = require('./routes/otpRoutes');
const biometricRoutes = require('./routes/biometricRoutes');
const accountRoutes = require('./routes/accountRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const securityRoutes = require('./routes/securityRoutes');
const complaintRoutes = require('./routes/complaintRoutes');
const adminRoutes = require('./routes/adminRoutes');
const merchantRoutes = require('./routes/merchantRoutes');

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    // Allow camera/mic access required for biometric face scanning
    permissionsPolicy: {
      features: {
        camera: ['*'],
        microphone: ['*'],
        geolocation: ['*'],
      },
    },
    // Allow CDN resources (face-api models, three.js) to load cross-origin
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(
  cors({
    origin(origin, callback) {
      // Allow all local origins (localhost, 127.0.0.1, LiveServer, null/file://)
      return callback(null, true);
    },
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(generalApiLimiter);

// Health check — used by frontend/api.js to auto-detect the API base URL and check DB health.
app.get('/api/health', async (req, res) => {
  let dbStatus = 'not_configured';
  try {
    const prisma = require('./prisma');
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = 'connected';
  } catch (e) {
    dbStatus = `unreachable (${e.code || e.message || 'error'})`;
  }
  res.json({
    ok: true,
    service: 'icash-backend',
    database: dbStatus,
    time: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/otp', otpRoutes);
app.use('/api/biometric', biometricRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/complaints', complaintRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/merchant', merchantRoutes);

// Any unmatched /api/* route is a genuine 404, not the SPA fallback.
app.use('/api', notFoundHandler);

// Serve the static frontend (index.html, script.js, style.css, api.js).
app.use(express.static(FRONTEND_DIR));

// SPA fallback for any other non-API route.
app.get('*', (req, res) => {
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
    const { req: appwriteReq, res: appwriteRes, log, error } = contextOrReq;
    const reqPath = appwriteReq.path || '/';

    const sendResponse = (body, status = 200, headers = {}) => {
      if (typeof appwriteRes.send === 'function') {
        return appwriteRes.send(body, status, headers);
      }
      if (typeof appwriteRes.text === 'function' && typeof body === 'string') {
        return appwriteRes.text(body, status, headers);
      }
      if (typeof appwriteRes.json === 'function') {
        return appwriteRes.json(typeof body === 'string' ? { content: body } : body, status, headers);
      }
    };

    // Health check
    if (reqPath === '/api/health' || reqPath === '/health') {
      return typeof appwriteRes.json === 'function'
        ? appwriteRes.json({
            ok: true,
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
    console.log('ℹ️  Using default DATABASE_URL. For persistent cloud storage, provide your PostgreSQL URL (e.g. Supabase or Neon).');
    return;
  }
  try {
    const { execSync } = require('child_process');
    console.log('🔄 Checking database schema with Prisma db push...');
    const prismaBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma');
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


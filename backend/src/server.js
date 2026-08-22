const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

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

// Allow the phone.email widget's iframe/script and inline handlers used by the
// existing frontend (onclick="..." attributes throughout index.html).
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);

app.use(
  cors({
    origin(origin, callback) {
      // Allow all local origins (localhost, 127.0.0.1, LiveServer, null/file://)
      return callback(null, true);
    },
    credentials: true
  })
);

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(generalApiLimiter);

// Health check — used by frontend/api.js to auto-detect the API base URL.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'icash-backend', time: new Date().toISOString() });
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

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`\n=======================================================`);
    console.log(`🚀 iCash Full-Stack Banking Backend running on: http://localhost:${port}`);
    console.log(`🔒 Security: Argon2/Bcrypt + HTTP-Only Session Cookies`);
    console.log(`🗄️  Database: PostgreSQL with Prisma ORM`);
    console.log(`👁️  Biometrics: Facial Feature Vector Verification Gate`);
    console.log(`=======================================================\n`);
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

module.exports = app;

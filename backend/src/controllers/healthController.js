const prisma = require('../prisma');

let pkgVersion = '2.0.0';
try {
  const pkg = require('../../package.json');
  pkgVersion = pkg.version || '2.0.0';
} catch (e) {
  try {
    const pkg = require('../package.json');
    pkgVersion = pkg.version || '2.0.0';
  } catch (err) {
    // fallback
  }
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

class HealthController {
  /**
   * Comprehensive health check endpoint
   * GET /health or GET /api/health
   */
  static async getHealth(req, res) {
    const startTime = Date.now();
    let dbStatus = 'not_configured';
    let dbLatencyMs = null;
    let isHealthy = true;

    try {
      const dbStart = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      dbLatencyMs = Date.now() - dbStart;
      dbStatus = 'connected';
    } catch (e) {
      dbStatus = `unreachable (${e.code || e.message || 'error'})`;
      isHealthy = false;
    }

    const mem = process.memoryUsage();
    const uptimeSec = process.uptime();

    const responseData = {
      ok: true,
      status: isHealthy ? 'healthy' : 'degraded',
      service: 'icash-backend',
      version: pkgVersion,
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
      uptime: {
        seconds: Math.floor(uptimeSec),
        formatted: formatUptime(uptimeSec),
      },
      system: {
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
        memory: {
          heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
          heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
          rssMB: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
        },
      },
      database: {
        status: dbStatus,
        latencyMs: dbLatencyMs,
      },
      services: {
        smsProvider: process.env.SMS_PROVIDER || 'console',
        biometricProvider: process.env.BIOMETRIC_PROVIDER || 'demo',
      },
      responseTimeMs: Date.now() - startTime,
    };

    return res.status(200).json(responseData);
  }

  /**
   * Lightweight liveness probe (K8s/Docker/Load Balancer)
   * GET /healthz or GET /live
   */
  static async getLiveness(req, res) {
    return res.status(200).json({
      ok: true,
      status: 'alive',
      service: 'icash-backend',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Readiness probe: checks if critical dependencies (DB) are ready to accept traffic
   * GET /ready or GET /api/ready
   */
  static async getReadiness(req, res) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return res.status(200).json({
        ok: true,
        status: 'ready',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return res.status(503).json({
        ok: false,
        status: 'not_ready',
        database: `unreachable (${e.code || e.message || 'error'})`,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

module.exports = HealthController;

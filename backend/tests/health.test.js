const request = require('supertest');
const app = require('../src/server');
const prisma = require('../src/prisma');

describe('Health Check & Probe Endpoints', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('GET /health - Returns 200 and comprehensive system health metadata', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('healthy');
    expect(res.body.service).toBe('icash-backend');
    expect(res.body.version).toBeDefined();
    expect(res.body.timestamp).toBeDefined();

    // Uptime checks
    expect(res.body.uptime).toBeDefined();
    expect(typeof res.body.uptime.seconds).toBe('number');
    expect(typeof res.body.uptime.formatted).toBe('string');

    // System checks
    expect(res.body.system).toBeDefined();
    expect(res.body.system.nodeVersion).toBe(process.version);
    expect(res.body.system.memory).toBeDefined();
    expect(typeof res.body.system.memory.heapUsedMB).toBe('number');

    // Database checks
    expect(res.body.database).toBeDefined();
    expect(res.body.database.status).toBe('connected');
    expect(typeof res.body.database.latencyMs).toBe('number');

    // Integrations
    expect(res.body.services).toBeDefined();
    expect(res.body.services.smsProvider).toBeDefined();
  });

  test('GET /api/health - Returns 200 identical to /health for client compatibility', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('icash-backend');
    expect(res.body.database.status).toBe('connected');
  });

  test('HEAD /health - Returns 200 OK for lightweight ping', async () => {
    const res = await request(app).head('/health');
    expect(res.status).toBe(200);
  });

  test('GET /healthz and /live - Lightweight liveness probe', async () => {
    const resHealthz = await request(app).get('/healthz');
    expect(resHealthz.status).toBe(200);
    expect(resHealthz.body.ok).toBe(true);
    expect(resHealthz.body.status).toBe('alive');

    const resLive = await request(app).get('/live');
    expect(resLive.status).toBe(200);
    expect(resLive.body.ok).toBe(true);
    expect(resLive.body.status).toBe('alive');
  });

  test('GET /ready and /api/ready - Readiness probe with DB verification', async () => {
    const resReady = await request(app).get('/ready');
    expect(resReady.status).toBe(200);
    expect(resReady.body.ok).toBe(true);
    expect(resReady.body.status).toBe('ready');
    expect(resReady.body.database).toBe('connected');

    const resApiReady = await request(app).get('/api/ready');
    expect(resApiReady.status).toBe(200);
    expect(resApiReady.body.ok).toBe(true);
  });
});

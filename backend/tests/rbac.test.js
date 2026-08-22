const request = require('supertest');
const app = require('../src/server');
const prisma = require('../src/prisma');
const { signToken } = require('../src/utils/token');

describe('Role-Based Access Control (RBAC) Tests', () => {
  let regularUser, merchantUser, adminUser;
  let userToken, merchantToken, adminToken;

  beforeAll(async () => {
    regularUser = await prisma.user.findFirst({ where: { role: 'USER' } });
    merchantUser = await prisma.user.findFirst({ where: { role: 'MERCHANT' } });
    adminUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });

    userToken = signToken({ userId: regularUser.id, role: regularUser.role });
    merchantToken = signToken({ userId: merchantUser.id, role: merchantUser.role });
    adminToken = signToken({ userId: adminUser.id, role: adminUser.role });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('GET /api/admin/users - Rejects unauthenticated request with 401 Unauthorized', async () => {
    const res = await request(app).get('/api/admin/users');
    expect(res.status).toBe(401);
  });

  test('GET /api/admin/users - Rejects regular USER with 403 Forbidden', async () => {
    const res = await request(app)
      .get('/api/admin/users')
      .set('Cookie', [`icash_session=${userToken}`]);

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  test('GET /api/admin/users - Rejects MERCHANT with 403 Forbidden', async () => {
    const res = await request(app)
      .get('/api/admin/users')
      .set('Cookie', [`icash_session=${merchantToken}`]);

    expect(res.status).toBe(403);
  });

  test('GET /api/admin/users - Allows ADMIN with 200 OK and lists users', async () => {
    const res = await request(app)
      .get('/api/admin/users')
      .set('Cookie', [`icash_session=${adminToken}`]);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.users.length).toBeGreaterThanOrEqual(3);
  });

  test('GET /api/merchant/profile - Rejects regular USER with 403 Forbidden', async () => {
    const res = await request(app)
      .get('/api/merchant/profile')
      .set('Cookie', [`icash_session=${userToken}`]);

    expect(res.status).toBe(403);
  });

  test('GET /api/merchant/profile - Allows MERCHANT with 200 OK', async () => {
    const res = await request(app)
      .get('/api/merchant/profile')
      .set('Cookie', [`icash_session=${merchantToken}`]);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.merchant.businessName).toBeDefined();
  });
});

const request = require('supertest');
const app = require('../src/server');
const prisma = require('../src/prisma');
const { signToken } = require('../src/utils/token');

describe('User Account Isolation Tests', () => {
  let userA, userB;
  let tokenA, _tokenB;
  let accountA, accountB;

  beforeAll(async () => {
    // Look up Sidd Paul (User A)
    userA = await prisma.user.findFirst({ where: { phone: '9876543210' } });
    accountA = await prisma.bankAccount.findFirst({
      where: { user_id: userA.id, is_primary: true },
    });

    // Look up Ramesh Kumar (User B)
    userB = await prisma.user.findFirst({ where: { phone: '9811122233' } });
    accountB = await prisma.bankAccount.findFirst({
      where: { user_id: userB.id, is_primary: true },
    });

    tokenA = signToken({ userId: userA.id, role: userA.role });
    _tokenB = signToken({ userId: userB.id, role: userB.role });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('GET /api/accounts - User A only sees their own accounts', async () => {
    const res = await request(app)
      .get('/api/accounts')
      .set('Cookie', [`icash_session=${tokenA}`]);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const accountIds = res.body.accounts.map((a) => a.id);
    expect(accountIds).toContain(accountA.id);
    expect(accountIds).not.toContain(accountB.id);
  });

  test('PATCH /api/accounts/:id - User A cannot modify User B account', async () => {
    const res = await request(app)
      .patch(`/api/accounts/${accountB.id}`) // Attempting to modify User B's account with User A's token
      .set('Cookie', [`icash_session=${tokenA}`])
      .send({ bankName: 'Hacked Bank Name' });

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  test('DELETE /api/accounts/:id - User A cannot delete User B account', async () => {
    const res = await request(app)
      .delete(`/api/accounts/${accountB.id}`)
      .set('Cookie', [`icash_session=${tokenA}`]);

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  test('GET /api/transactions/:id - User A cannot view User B transaction details', async () => {
    const txB = await prisma.transaction.findFirst({ where: { user_id: userB.id } });
    if (txB) {
      const res = await request(app)
        .get(`/api/transactions/${txB.id}`)
        .set('Cookie', [`icash_session=${tokenA}`]);

      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    }
  });
});

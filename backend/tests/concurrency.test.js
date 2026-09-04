const request = require('supertest');
const app = require('../src/server');
const prisma = require('../src/prisma');
const { signToken } = require('../src/utils/token');

describe('Concurrency & Race Condition Defenses', () => {
  let testUser;
  let testAccount;
  let userToken;

  beforeAll(async () => {
    // Look up Sidd Paul (pre-seeded)
    testUser = await prisma.user.findFirst({ where: { phone: '9876543210' } });
    testAccount = await prisma.bankAccount.findFirst({
      where: { user_id: testUser.id, is_primary: true },
    });
    userToken = signToken({ userId: testUser.id, role: testUser.role });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('Double-spend prevention: concurrent withdrawals exceeding balance allow only one to succeed', async () => {
    // 1. Set balance to exactly ₹1,000 for this test
    await prisma.bankAccount.update({
      where: { id: testAccount.id },
      data: { balance: 1000.0 },
    });

    // 2. Fire two simultaneous withdrawal requests of ₹700 each
    const req1 = request(app)
      .post('/api/transactions')
      .set('Cookie', [`icash_session=${userToken}`])
      .send({
        amount: 700,
        transactionType: 'WITHDRAWAL',
        description: 'Concurrent race test 1',
      });

    const req2 = request(app)
      .post('/api/transactions')
      .set('Cookie', [`icash_session=${userToken}`])
      .send({
        amount: 700,
        transactionType: 'WITHDRAWAL',
        description: 'Concurrent race test 2',
      });

    const [res1, res2] = await Promise.all([req1, req2]);

    // One must succeed (201), the other must fail with 400 (insufficient balance)
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 400]);

    // Verify final account balance is exactly 300, not -400
    const finalAccount = await prisma.bankAccount.findUnique({
      where: { id: testAccount.id },
    });
    expect(Number(finalAccount.balance)).toBe(300);
  });

  test('Idempotency: repeating transaction with identical idempotencyKey does not double-deduct', async () => {
    // Reset balance to ₹10,000
    await prisma.bankAccount.update({
      where: { id: testAccount.id },
      data: { balance: 10000.0 },
    });

    const idempotencyKey = `idem-test-${Date.now()}`;

    // First request
    const res1 = await request(app)
      .post('/api/transactions')
      .set('Cookie', [`icash_session=${userToken}`])
      .send({
        amount: 1500,
        transactionType: 'WITHDRAWAL',
        idempotencyKey,
        description: 'Idempotency test withdrawal',
      });

    expect(res1.status).toBe(201);
    expect(res1.body.ok).toBe(true);

    // Second request with SAME idempotency key (simulating retry)
    const res2 = await request(app)
      .post('/api/transactions')
      .set('Cookie', [`icash_session=${userToken}`])
      .send({
        amount: 1500,
        transactionType: 'WITHDRAWAL',
        idempotencyKey,
        description: 'Idempotency test withdrawal (duplicate retry)',
      });

    expect(res2.status).toBe(200);
    expect(res2.body.ok).toBe(true);

    // Balance must be 8500 (deducted once), NOT 7000 (deducted twice)
    const finalAccount = await prisma.bankAccount.findUnique({
      where: { id: testAccount.id },
    });
    expect(Number(finalAccount.balance)).toBe(8500);
  });

  test('Concurrent emergency withdrawal claim: only one claimant succeeds', async () => {
    // Look up senior citizen Ramesh Kumar (pre-seeded)
    const seniorUser = await prisma.user.findFirst({ where: { phone: '9811122233' } });
    const seniorToken = signToken({ userId: seniorUser.id, role: seniorUser.role });

    // Generate delegation OTP
    const genRes = await request(app)
      .post('/api/transactions/delegate/generate')
      .set('Cookie', [`icash_session=${seniorToken}`])
      .send({ amount: 500 });

    expect(genRes.status).toBe(200);
    const otp = genRes.body.otp;

    // Simulate 2 parallel claims with the same OTP
    const claim1 = request(app)
      .post('/api/transactions/delegate/claim')
      .send({ seniorName: 'Ramesh Kumar', otp });

    const claim2 = request(app)
      .post('/api/transactions/delegate/claim')
      .send({ seniorName: 'Ramesh Kumar', otp });

    const [c1, c2] = await Promise.all([claim1, claim2]);
    const statuses = [c1.status, c2.status].sort();

    // Exactly one claim must succeed (200), and the concurrent one must fail (400/404)
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);
  });
});

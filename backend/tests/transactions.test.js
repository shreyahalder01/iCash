const request = require('supertest');
const app = require('../src/server');
const prisma = require('../src/prisma');
const { signToken } = require('../src/utils/token');

describe('Transaction & Balance APIs', () => {
  let userA, userB, seniorUser;
  let tokenA, _tokenB, seniorToken;

  beforeAll(async () => {
    // Look up seeded users
    userA = await prisma.user.findFirst({ where: { phone: '9876543210' } }); // Sidd Paul
    seniorUser = await prisma.user.findFirst({ where: { phone: '9811122233' } }); // Ramesh Kumar

    // Ensure userA primary account has sufficient test balance
    await prisma.bankAccount.updateMany({
      where: { user_id: userA.id, is_primary: true },
      data: { balance: 25000.0 },
    });

    // Create a temporary User B for transfer tests
    await prisma.user.deleteMany({ where: { phone: '9111222333' } });
    userB = await prisma.user.create({
      data: {
        full_name: 'Recipient User B',
        phone: '9111222333',
        aadhaar_reference: 'AADHAAR_USER_B',
        aadhaar_last4: '2222',
        password_hash: '$2a$12$e/dummyhash',
        accounts: {
          create: {
            bank_name: 'iCash Federal Digital Bank',
            account_number_masked: '•••• 2222',
            account_reference: 'ACC_USER_B_PRIM',
            account_type: 'SAVINGS',
            balance: 5000.0,
            is_primary: true,
          },
        },
      },
    });

    tokenA = signToken({ userId: userA.id, role: userA.role });
    _tokenB = signToken({ userId: userB.id, role: userB.role });
    seniorToken = signToken({ userId: seniorUser.id, role: seniorUser.role });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { phone: '9111222333' } });
    await prisma.$disconnect();
  });

  test('POST /api/transactions - ATM withdrawal deducts balance atomically', async () => {
    const accountBefore = await prisma.bankAccount.findFirst({
      where: { user_id: userA.id, is_primary: true },
    });
    const initialBal = Number(accountBefore.balance);

    const res = await request(app)
      .post('/api/transactions')
      .set('Cookie', [`icash_session=${tokenA}`])
      .send({
        transactionType: 'WITHDRAWAL',
        amount: 3000,
        description: 'ATM withdrawal test',
        verifyMethod: 'FACE',
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.newBalance).toBe(initialBal - 3000);

    const accountAfter = await prisma.bankAccount.findFirst({
      where: { user_id: userA.id, is_primary: true },
    });
    expect(Number(accountAfter.balance)).toBe(initialBal - 3000);
  });

  test('POST /api/transactions - Overdraft rejected with 400 Insufficient Funds', async () => {
    const res = await request(app)
      .post('/api/transactions')
      .set('Cookie', [`icash_session=${tokenA}`])
      .send({
        transactionType: 'WITHDRAWAL',
        amount: 99999999, // Way more than balance
        description: 'Overdraft attempt',
      });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toContain('Insufficient');
  });

  test('POST /api/transactions - P2P Transfer credits recipient and debits sender', async () => {
    const senderAccBefore = await prisma.bankAccount.findFirst({
      where: { user_id: userA.id, is_primary: true },
    });
    const recipientAccBefore = await prisma.bankAccount.findFirst({
      where: { user_id: userB.id, is_primary: true },
    });

    const transferAmt = 1500;

    const res = await request(app)
      .post('/api/transactions')
      .set('Cookie', [`icash_session=${tokenA}`])
      .send({
        transactionType: 'TRANSFER',
        amount: transferAmt,
        description: 'P2P test transfer',
        recipientName: 'Recipient User B',
        recipientUserId: userB.id,
        verifyMethod: 'PIN',
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    const senderAccAfter = await prisma.bankAccount.findFirst({
      where: { user_id: userA.id, is_primary: true },
    });
    const recipientAccAfter = await prisma.bankAccount.findFirst({
      where: { user_id: userB.id, is_primary: true },
    });

    expect(Number(senderAccAfter.balance)).toBe(Number(senderAccBefore.balance) - transferAmt);
    expect(Number(recipientAccAfter.balance)).toBe(
      Number(recipientAccBefore.balance) + transferAmt
    );
  });

  test('POST /api/transactions/delegate/generate & claim - Senior citizen trusted contact OTP withdrawal', async () => {
    // 1. Senior generates OTP for ₹2,000
    const genRes = await request(app)
      .post('/api/transactions/delegate/generate')
      .set('Cookie', [`icash_session=${seniorToken}`])
      .send({ amount: 2000 });

    expect(genRes.status).toBe(200);
    expect(genRes.body.ok).toBe(true);
    expect(genRes.body.otp).toBeDefined();

    const otp = genRes.body.otp;

    // 2. Trusted contact claims OTP from public endpoint
    const claimRes = await request(app).post('/api/transactions/delegate/claim').send({
      seniorName: 'Ramesh Kumar',
      otp,
    });

    expect(claimRes.status).toBe(200);
    expect(claimRes.body.ok).toBe(true);
    expect(claimRes.body.amount).toBe(2000);
  });

  test('GET /api/transactions/lookup-recipient - Resolves registered user by 10-digit mobile number', async () => {
    const res = await request(app)
      .get('/api/transactions/lookup-recipient?phone=9111222333')
      .set('Cookie', [`icash_session=${tokenA}`]);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.found).toBe(true);
    expect(res.body.recipient.name).toBe('Recipient User B');
    expect(res.body.recipient.phone).toBe('9111222333');
  });

  test('POST /api/transactions - Phone-to-phone transfer credits recipient wallet automatically', async () => {
    const recipientAccBefore = await prisma.bankAccount.findFirst({
      where: { user_id: userB.id, is_primary: true },
    });
    const initialBal = Number(recipientAccBefore.balance);

    const res = await request(app)
      .post('/api/transactions')
      .set('Cookie', [`icash_session=${tokenA}`])
      .send({
        transactionType: 'TRANSFER',
        amount: 800,
        recipientPhone: '9111222333',
        description: 'Phone transfer to user B',
        verifyMethod: 'PIN',
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    const recipientAccAfter = await prisma.bankAccount.findFirst({
      where: { user_id: userB.id, is_primary: true },
    });
    expect(Number(recipientAccAfter.balance)).toBe(initialBal + 800);
  });

  test('POST /api/transactions - Special emergency PIN 9999 triggers covert duress police alert', async () => {
    const res = await request(app)
      .post('/api/transactions')
      .set('Cookie', [`icash_session=${tokenA}`])
      .send({
        transactionType: 'TRANSFER',
        amount: 500,
        recipientPhone: '9111222333',
        pin: '9999',
        verifyMethod: 'PIN',
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.isDuress).toBe(true);
    expect(res.body.policeAlertTriggered).toBe(true);

    // Verify DURESS_ALERT audit event was recorded
    const event = await prisma.securityEvent.findFirst({
      where: { user_id: userA.id, event_type: 'DURESS_ALERT' },
      orderBy: { created_at: 'desc' },
    });
    expect(event).not.toBeNull();
    expect(event.severity).toBe('CRITICAL');
  });

  test('POST /api/complaints & GET /api/complaints - Submits dispute ticket and retrieves list', async () => {
    const createRes = await request(app)
      .post('/api/complaints')
      .set('Cookie', [`icash_session=${tokenA}`])
      .send({
        subject: 'ATM cash dispensing error',
        description: 'Atm billed 500 but cash tray failed to eject notes.',
        category: 'ATM Cash Issue',
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.ok).toBe(true);
    expect(createRes.body.complaint.subject).toContain('ATM cash dispensing error');
    expect(createRes.body.complaint.status).toBe('OPEN');

    const getRes = await request(app)
      .get('/api/complaints')
      .set('Cookie', [`icash_session=${tokenA}`]);

    expect(getRes.status).toBe(200);
    expect(getRes.body.ok).toBe(true);
    expect(Array.isArray(getRes.body.complaints)).toBe(true);
    expect(getRes.body.complaints.length).toBeGreaterThan(0);
    expect(getRes.body.complaints[0].subject).toBeDefined();
  });
});

const request = require('supertest');
const app = require('../src/server');
const prisma = require('../src/prisma');

describe('Auth & Session APIs', () => {
  const testPhone = '9988776655';
  const testAadhaar = '123456789012';

  beforeAll(async () => {
    // Clean up any existing test user with test phone
    await prisma.user.deleteMany({
      where: { phone: testPhone },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { phone: testPhone },
    });
    await prisma.$disconnect();
  });

  test('POST /api/auth/register - Successfully registers user with masked Aadhaar and primary account', async () => {
    const res = await request(app).post('/api/auth/register').send({
      fullName: 'Test Verification User',
      phone: testPhone,
      email: 'test.verify@icash.bank',
      aadhaarNumber: testAadhaar,
      pin: '5566',
      emergencyPin: '9988',
      isSenior: false,
      dob: '1995-01-01',
    });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.phone).toBe(testPhone);
    expect(res.body.user.aadhaarLast4).toBe('9012');
    expect(res.body.user.password_hash).toBeUndefined(); // Never leak hash
    expect(res.body.user.primaryAccount).toBeDefined();
    expect(res.body.user.primaryAccount.balance).toBe(25000);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  test('POST /api/auth/register - Rejects duplicate phone number with 409 Conflict', async () => {
    const res = await request(app).post('/api/auth/register').send({
      fullName: 'Duplicate User',
      phone: testPhone,
      aadhaarNumber: '999988887777',
      pin: '5566',
      emergencyPin: '1122',
    });

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
  });

  test('POST /api/auth/login-aadhaar - Finds user by Aadhaar last 4 digits', async () => {
    const res = await request(app).post('/api/auth/login-aadhaar').send({ aadhaarLast4: '9012' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.users.length).toBeGreaterThanOrEqual(1);
    expect(res.body.users[0].aadhaarLast4).toBe('9012');
  });

  test('POST /api/auth/login-pin - Valid PIN logs in and sets session cookie', async () => {
    const lookup = await request(app)
      .post('/api/auth/login-aadhaar')
      .send({ aadhaarLast4: '9012' });

    const user = lookup.body.users.find((u) => u.phone === testPhone) || lookup.body.users[0];
    const userId = user.id;

    const res = await request(app).post('/api/auth/login-pin').send({ userId, pin: '5566' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.id).toBe(userId);
    expect(res.body.isDuress).toBe(false);
  });

  test('POST /api/auth/login-pin - Emergency PIN logs in and triggers covert duress alert', async () => {
    const lookup = await request(app)
      .post('/api/auth/login-aadhaar')
      .send({ aadhaarLast4: '9012' });

    const user = lookup.body.users.find((u) => u.phone === testPhone) || lookup.body.users[0];
    const userId = user.id;

    const res = await request(app).post('/api/auth/login-pin').send({ userId, pin: '9988' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.isDuress).toBe(true);

    // Verify duress event logged in DB
    const event = await prisma.securityEvent.findFirst({
      where: { user_id: userId, event_type: 'DURESS_ALERT' },
    });
    expect(event).not.toBeNull();
    expect(event.severity).toBe('CRITICAL');
  });

  test('POST /api/auth/login-pin - Locks account after 5 consecutive failed attempts', async () => {
    const lookup = await request(app)
      .post('/api/auth/login-aadhaar')
      .send({ aadhaarLast4: '9012' });

    const user = lookup.body.users.find((u) => u.phone === testPhone) || lookup.body.users[0];
    const userId = user.id;

    // 5 failed PIN attempts
    for (let i = 0; i < 4; i++) {
      const failRes = await request(app).post('/api/auth/login-pin').send({ userId, pin: '0000' });
      expect(failRes.status).toBe(401);
    }

    // 5th attempt locks the account
    const fifthRes = await request(app).post('/api/auth/login-pin').send({ userId, pin: '0000' });
    expect(fifthRes.status).toBe(401);
    expect(fifthRes.body.message).toContain('restricted');

    // 6th attempt should be rejected with 403 AccountLocked
    const sixthRes = await request(app).post('/api/auth/login-pin').send({ userId, pin: '5566' }); // even with correct PIN
    expect(sixthRes.status).toBe(403);
  });

  test('DELETE /api/auth/me - Requires PIN confirmation and deletes user permanently from DB', async () => {
    const deletePhone = '9900112233';
    const deleteAadhaar = '987654321098';

    await prisma.user.deleteMany({ where: { phone: deletePhone } });

    // Register user to test deletion
    const regRes = await request(app).post('/api/auth/register').send({
      fullName: 'User To Delete',
      phone: deletePhone,
      email: 'delete.me@icash.bank',
      aadhaarNumber: deleteAadhaar,
      pin: '4321',
      emergencyPin: '8765',
      isSenior: false,
    });
    expect(regRes.status).toBe(201);
    const cookies = regRes.headers['set-cookie'];
    const deleteUserId = regRes.body.user.id;

    // Attempt delete with invalid PIN
    const wrongPinRes = await request(app)
      .delete('/api/auth/me')
      .set('Cookie', cookies)
      .send({ pin: '0000' });
    expect(wrongPinRes.status).toBe(401);

    // Attempt delete with correct PIN
    const successRes = await request(app)
      .delete('/api/auth/me')
      .set('Cookie', cookies)
      .send({ pin: '4321' });
    expect(successRes.status).toBe(200);
    expect(successRes.body.ok).toBe(true);

    // Verify user is deleted from database
    const dbUser = await prisma.user.findUnique({ where: { id: deleteUserId } });
    expect(dbUser).toBeNull();
  });
});

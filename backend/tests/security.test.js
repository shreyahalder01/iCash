const request = require('supertest');
const app = require('../src/server');
const prisma = require('../src/prisma');
const { signToken } = require('../src/utils/token');

describe('Security Events & Biometrics APIs', () => {
  let regularUser;
  let userToken;

  beforeAll(async () => {
    regularUser = await prisma.user.findFirst({ where: { role: 'USER' } });
    userToken = signToken({ userId: regularUser.id, role: regularUser.role });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('POST /api/security/events - Logs MULTIPLE_FACE_DETECTED anomaly', async () => {
    const res = await request(app)
      .post('/api/security/events')
      .set('Cookie', [`icash_session=${userToken}`])
      .send({
        eventType: 'MULTIPLE_FACE_DETECTED',
        severity: 'HIGH',
        description: 'Two faces detected during biometric scan.'
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    const saved = await prisma.securityEvent.findFirst({
      where: {
        user_id: regularUser.id,
        event_type: 'MULTIPLE_FACE_DETECTED'
      }
    });
    expect(saved).not.toBeNull();
    expect(saved.severity).toBe('HIGH');
  });

  test('GET /api/security/status - Returns security status and active alerts', async () => {
    const res = await request(app)
      .get('/api/security/status')
      .set('Cookie', [`icash_session=${userToken}`]);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBeDefined();
    expect(res.body.status.accountStatus).toBe('ACTIVE');
    expect(res.body.status.isLocked).toBe(false);
  });

  test('POST /api/biometric/enroll & /verify - Server-side facial verification', async () => {
    // Generate a mock 128D descriptor vector
    const mockVector = Array.from({ length: 128 }, (_, i) => Math.sin(i));

    const enrollRes = await request(app)
      .post('/api/biometric/enroll')
      .set('Cookie', [`icash_session=${userToken}`])
      .send({
        descriptors: [mockVector]
      });

    expect(enrollRes.status).toBe(200);
    expect(enrollRes.body.ok).toBe(true);

    // Verify with same vector (exact match -> distance 0)
    const verifyRes = await request(app)
      .post('/api/biometric/verify')
      .set('Cookie', [`icash_session=${userToken}`])
      .send({
        liveDescriptor: mockVector
      });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.ok).toBe(true);
    expect(verifyRes.body.matched).toBe(true);
    expect(verifyRes.body.distance).toBe(0);
  });
});

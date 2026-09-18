const { betterAuth } = require('better-auth');
const { prismaAdapter } = require('better-auth/adapters/prisma');
const { dash } = require('@better-auth/infra');
const prisma = require('./prisma');

const auth = betterAuth({
  baseURL:
    process.env.BETTER_AUTH_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    'https://icash.onrender.com',
  secret:
    process.env.BETTER_AUTH_SECRET ||
    process.env.BETTER_AUTH_API_KEY ||
    process.env.JWT_SECRET ||
    'default-secret-better-auth-key-change-in-production',
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  user: {
    modelName: 'User',
    fields: {
      name: 'full_name',
      emailVerified: 'email_verified',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  session: {
    modelName: 'Session',
  },
  account: {
    modelName: 'Account',
  },
  verification: {
    modelName: 'Verification',
  },
  plugins: [
    dash({
      apiKey: process.env.BETTER_AUTH_API_KEY,
    }),
  ],
});

module.exports = { auth };

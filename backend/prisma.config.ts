import 'dotenv/config';

// Prisma 7+ expects datasource connection URLs to be provided via a JS/TS config file
// rather than the `url` property inside schema.prisma. This file provides that
// configuration by reading DATABASE_URL from environment variables.

export const config = {
  datasources: {
    db: {
      provider: 'postgresql',
      // Use DATABASE_URL from the environment (ensure .env is set for dev/test)
      url: process.env.DATABASE_URL,
    },
  },
};

export default config;

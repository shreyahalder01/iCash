/**
 * Prisma Client Singleton
 *
 * Prevents exhausting database connections from hot-reloads (`node --watch`)
 * by reusing a single PrismaClient instance across the process.
 */
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const globalForPrisma = globalThis;

// Create a Postgres adapter using the DATABASE_URL environment variable.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

const prisma =
  globalForPrisma.__icashPrisma ||
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__icashPrisma = prisma;
}

module.exports = prisma;

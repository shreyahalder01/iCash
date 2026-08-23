/**
 * Prisma Client Singleton
 *
 * Prevents exhausting database connections from hot-reloads (`node --watch`)
 * by reusing a single PrismaClient instance across the process.
 */
const { PrismaClient } = require('@prisma/client');

const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.__icashPrisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__icashPrisma = prisma;
}

module.exports = prisma;

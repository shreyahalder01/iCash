/**
 * Jest Global Setup
 * Runs once before all test suites. Seeds the test database so all integration
 * tests have isolated, deterministic fixture data regardless of test run order
 * or whether the database was freshly migrated.
 */
const { seed } = require('../prisma/seed');
const prisma = require('../src/prisma');

module.exports = async () => {
  try {
    await seed();
  } catch (err) {
    console.error('Failed to run global test seed:', err);
    throw err;
  } finally {
    await prisma.$disconnect();
  }
};

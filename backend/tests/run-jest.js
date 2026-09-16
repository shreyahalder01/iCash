process.env.NODE_ENV = 'test';

const { spawnSync } = require('child_process');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('pool_timeout')) {
  process.env.DATABASE_URL += '&pool_timeout=30';
}

const jestPath = require.resolve('jest/bin/jest');

const result = spawnSync(
  process.execPath,
  [jestPath, '--runInBand', '--detectOpenHandles', '--forceExit', ...process.argv.slice(2)],
  { stdio: 'inherit' }
);

if (result.error) {
  throw result.error;
}

process.exit(result.status === null ? 1 : result.status);

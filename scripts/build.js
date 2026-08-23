const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const frontendDir = path.join(rootDir, 'frontend');
const distDir = path.join(rootDir, 'dist');

console.log('[Build] 1. Generating Prisma Client...');
try {
  execSync('npx prisma generate --schema=backend/prisma/schema.prisma', {
    cwd: rootDir,
    stdio: 'inherit',
  });
} catch (err) {
  console.error('[Build] Prisma generation failed:', err.message);
  process.exit(1);
}

console.log('[Build] 2. Preparing output bundle directories...');
const targetDirs = [
  distDir,
  path.join(distDir, 'angular'),
  path.join(distDir, 'browser'),
  path.join(distDir, 'icash'),
  path.join(distDir, 'frontend'),
];

for (const dir of targetDirs) {
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(frontendDir, dir, { recursive: true });
}

console.log('[Build] Build completed successfully.');

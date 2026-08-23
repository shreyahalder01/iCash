const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const frontendDir = path.join(rootDir, 'frontend');
const distDir = path.join(rootDir, 'dist');
const nextDir = path.join(rootDir, '.next');
const buildDir = path.join(rootDir, 'build');

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

// 2a. Standard dist directories for SPA / Angular / Vite presets
const targetDirs = [
  distDir,
  path.join(distDir, 'angular'),
  path.join(distDir, 'browser'),
  path.join(distDir, 'icash'),
  path.join(distDir, 'frontend'),
  buildDir,
];

for (const dir of targetDirs) {
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(frontendDir, dir, { recursive: true });
}

// 2b. Next.js structure for Open-Runtimes next-js/bundle.sh compatibility
fs.mkdirSync(nextDir, { recursive: true });
fs.mkdirSync(path.join(nextDir, 'static'), { recursive: true });
fs.mkdirSync(path.join(nextDir, 'standalone'), { recursive: true });
fs.mkdirSync(path.join(nextDir, 'server', 'pages'), { recursive: true });

// Copy static assets to .next/static and .next/standalone
fs.cpSync(frontendDir, path.join(nextDir, 'static'), { recursive: true });
fs.cpSync(frontendDir, path.join(nextDir, 'standalone', 'public'), { recursive: true });
fs.writeFileSync(path.join(nextDir, 'BUILD_ID'), 'icash-production-build');

const requiredFilesJson = JSON.stringify(
  {
    version: 1,
    config: {
      distDir: '.next',
      output: 'standalone',
    },
    files: ['.next/routes-manifest.json'],
  },
  null,
  2
);
fs.writeFileSync(path.join(nextDir, 'required-server-files.json'), requiredFilesJson);

// Standalone entrypoint for Next.js SSR runners
const standaloneServerJs = `
const path = require('path');
process.env.PORT = process.env.PORT || '3000';
try {
  require(path.join(__dirname, '..', '..', 'backend', 'src', 'server.js'));
} catch (e) {
  try {
    require(path.join(process.cwd(), 'backend', 'src', 'server.js'));
  } catch (e2) {
    require('./backend/src/server.js');
  }
}
`;
fs.writeFileSync(path.join(nextDir, 'standalone', 'server.js'), standaloneServerJs);

// Also copy backend to standalone folder for isolated runtimes
try {
  fs.cpSync(path.join(rootDir, 'backend'), path.join(nextDir, 'standalone', 'backend'), { recursive: true });
  fs.copyFileSync(path.join(rootDir, 'package.json'), path.join(nextDir, 'standalone', 'package.json'));
} catch (e) {
  // best effort copy
}

console.log('[Build] Build completed successfully.');

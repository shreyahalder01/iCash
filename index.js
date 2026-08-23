/**
 * Appwrite Function & Root Node.js Entrypoint
 * Bridges Appwrite Open-Runtimes and standalone Node/Express executions.
 */
const path = require('path');
const server = require('./backend/src/server.js');

module.exports = server;
module.exports.default = server;

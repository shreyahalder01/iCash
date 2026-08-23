/**
 * Appwrite Function Entrypoint (src/main.js)
 * Default entrypoint for Appwrite Node.js functions.
 */
const server = require('../backend/src/server.js');

module.exports = server;
module.exports.default = server;

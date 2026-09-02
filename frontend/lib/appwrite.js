/**
 * iCash Appwrite SDK Client
 *
 * Loaded via CDN global (window.Appwrite). Exposes client, account,
 * and databases for use across the frontend.
 *
 * Project: iCash (6a8aa84f0038eaa84573)
 * Endpoint: https://nyc.cloud.appwrite.io/v1
 */

// Appwrite is loaded as a CDN global — no ES module import needed.
// This file acts as the single source of truth for Appwrite config.

const APPWRITE_ENDPOINT = 'https://nyc.cloud.appwrite.io/v1';
const APPWRITE_PROJECT_ID = '6a8aa84f0038eaa84573';

let client = null;
let account = null;
let databases = null;

function initAppwriteClient() {
  if (typeof Appwrite === 'undefined') {
    console.warn('[Appwrite] SDK not loaded yet.');
    return null;
  }
  const { Client, Account, Databases } = Appwrite;
  client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID);
  account = new Account(client);
  databases = new Databases(client);

  // Ping Appwrite backend to verify the setup is correct.
  // This runs automatically on every app load.
  client
    .ping()
    .then((res) => console.log('[Appwrite] Ping OK:', res))
    .catch((err) => console.warn('[Appwrite] Ping warning:', err.message || err));

  return { client, account, databases };
}

// Expose globally for use in script.js and biometric.js
window.AppwriteLib = { initAppwriteClient, getClient: () => client, getAccount: () => account, getDatabases: () => databases };

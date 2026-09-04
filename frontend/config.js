/**
 * iCash Frontend Configuration
 *
 * Keep production endpoints configurable so the same frontend can run locally
 * and against the deployed services without hard-coded localhost dependencies.
 */
window.ICASH_CONFIG = {
  // Empty = same-origin / automatic detection.
  API_BASE_URL: '',

  // Optional deployed Flask liveness service. Leave empty when the browser
  // should use the client-side biometric fallback.
  LIVENESS_URL: '',
};

const express = require('express');
const router = express.Router();
const HealthController = require('../controllers/healthController');

// Main Health Check: / or /health
router.get('/', HealthController.getHealth);
router.head('/', (req, res) => res.status(200).end());

// Liveness Probes: /live or /healthz
router.get('/live', HealthController.getLiveness);
router.get('/healthz', HealthController.getLiveness);

// Readiness Probes: /ready
router.get('/ready', HealthController.getReadiness);

module.exports = router;

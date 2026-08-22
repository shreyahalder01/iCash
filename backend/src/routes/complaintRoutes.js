const express = require('express');
const router = express.Router();
const ComplaintController = require('../controllers/complaintController');
const { authenticate } = require('../middleware/authMiddleware');
const { validateRequest } = require('../middleware/validateMiddleware');
const { complaintCreateSchema } = require('../utils/validator');

router.use(authenticate);

router.get('/', ComplaintController.getComplaints);
router.post('/', validateRequest(complaintCreateSchema), ComplaintController.createComplaint);

module.exports = router;

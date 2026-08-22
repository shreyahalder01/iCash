const express = require('express');
const router = express.Router();
const AdminController = require('../controllers/adminController');
const { authenticate } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roleMiddleware');
const { validateRequest } = require('../middleware/validateMiddleware');
const {
  userStatusUpdateSchema,
  complaintResolveSchema
} = require('../utils/validator');

router.use(authenticate);
router.use(requireRole('ADMIN'));

router.get('/users', AdminController.getAllUsers);
router.get('/users/:id', AdminController.getUserById);
router.patch('/users/:id/status', validateRequest(userStatusUpdateSchema), AdminController.updateUserStatus);
router.get('/transactions', AdminController.getAllTransactions);
router.get('/security-events', AdminController.getAllSecurityEvents);
router.get('/complaints', AdminController.getAllComplaints);
router.patch('/complaints/:id', validateRequest(complaintResolveSchema), AdminController.resolveComplaint);

module.exports = router;

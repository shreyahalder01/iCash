const express = require('express');
const router = express.Router();
const AccountController = require('../controllers/accountController');
const { authenticate } = require('../middleware/authMiddleware');
const { validateRequest } = require('../middleware/validateMiddleware');
const {
  accountCreateSchema,
  accountUpdateSchema
} = require('../utils/validator');

router.use(authenticate);

router.get('/', AccountController.getAccounts);
router.post('/', validateRequest(accountCreateSchema), AccountController.createAccount);
router.patch('/:id', validateRequest(accountUpdateSchema), AccountController.updateAccount);
router.delete('/:id', AccountController.deleteAccount);

module.exports = router;

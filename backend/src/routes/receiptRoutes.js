const express = require('express');
const multer = require('multer');
const { authenticate } = require('../middleware/authMiddleware');
const { scan } = require('../controllers/receiptController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (!/^image\/(jpeg|png|webp|tiff)$/.test(file.mimetype)) {
      return callback(new Error('Only JPEG, PNG, WEBP, and TIFF receipt images are supported.'));
    }
    callback(null, true);
  },
});

const router = express.Router();
router.use(authenticate);
router.post('/scan', upload.single('receipt'), scan);
module.exports = router;

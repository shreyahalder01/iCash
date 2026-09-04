const fs = require('fs/promises');
const path = require('path');
const { createWorker } = require('tesseract.js');
const prisma = require('../prisma');

function parseReceiptText(text) {
  const totalMatch = text.match(/(?:total|amount payable|grand total)[^\d]*(\d+(?:[.,]\d{1,2})?)/i);
  const taxMatch = text.match(/(?:tax|gst|vat)[^\d]*(\d+(?:[.,]\d{1,2})?)/i);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    merchant: lines[0]?.slice(0, 120) || null,
    total: totalMatch ? Number(totalMatch[1].replace(',', '.')) : null,
    tax: taxMatch ? Number(taxMatch[1].replace(',', '.')) : null,
    items: [],
  };
}

async function scanReceipt(userId, file) {
  const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'receipts');
  await fs.mkdir(uploadDir, { recursive: true });
  const imagePath = path.join(uploadDir, `${userId}-${Date.now()}-${path.basename(file.originalname)}`);
  await fs.writeFile(imagePath, file.buffer);

  const worker = await createWorker('eng');
  let text;
  try {
    const result = await worker.recognize(file.buffer);
    text = result.data.text || '';
  } finally {
    await worker.terminate();
  }
  const parsed = parseReceiptText(text);
  const receipt = await prisma.receipt.create({
    data: {
      user_id: userId,
      merchant: parsed.merchant,
      total: parsed.total,
      tax: parsed.tax,
      image_path: imagePath,
      confidence: text.trim() ? 0.75 : 0.1,
      items: { create: parsed.items },
    },
    include: { items: true },
  });
  return {
    id: receipt.id,
    merchant: receipt.merchant,
    date: receipt.receipt_date,
    total: receipt.total ? Number(receipt.total) : null,
    tax: receipt.tax ? Number(receipt.tax) : null,
    items: receipt.items,
    confidence: receipt.confidence ? Number(receipt.confidence) : 0,
  };
}

module.exports = { scanReceipt };

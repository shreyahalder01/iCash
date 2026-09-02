const prisma = require('../prisma');
const SecurityService = require('../services/securityService');

class ComplaintController {
  static async getComplaints(req, res, next) {
    try {
      const complaints = await prisma.complaint.findMany({
        where: { user_id: req.user.id },
        include: {
          transaction: {
            select: {
              reference_number: true,
              amount: true,
              transaction_type: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
      });

      res.json({
        ok: true,
        complaints,
      });
    } catch (err) {
      next(err);
    }
  }

  static async createComplaint(req, res, next) {
    try {
      const { transactionId, subject, description } = req.body;

      const complaint = await prisma.complaint.create({
        data: {
          user_id: req.user.id,
          transaction_id: transactionId || null,
          subject,
          description,
          status: 'OPEN',
        },
      });

      await SecurityService.recordEvent({
        userId: req.user.id,
        eventType: 'COMPLAINT_FILED',
        severity: 'LOW',
        description: `Dispute/Complaint submitted: ${subject}`,
        ipAddress: req.ip,
        deviceReference: req.headers['user-agent'],
      });

      res.status(201).json({
        ok: true,
        message: 'Complaint submitted successfully. An administrator will review your case.',
        complaint,
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = ComplaintController;

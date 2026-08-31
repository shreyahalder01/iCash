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

      const mappedComplaints = complaints.map((c) => ({
        id: c.id,
        subject: c.subject,
        description: c.description,
        status: c.status,
        adminResponse: c.admin_response,
        admin_response: c.admin_response,
        createdAt: c.created_at,
        created_at: c.created_at,
        transaction: c.transaction,
      }));

      res.json({
        ok: true,
        complaints: mappedComplaints,
      });
    } catch (err) {
      next(err);
    }
  }

  static async createComplaint(req, res, next) {
    try {
      const { transactionId, subject, description, category } = req.body;
      const sanitizedTxId =
        transactionId && String(transactionId).trim().length > 0
          ? String(transactionId).trim()
          : null;

      const fullSubject = category ? `[${category}] ${subject}` : subject;

      const complaint = await prisma.complaint.create({
        data: {
          user_id: req.user.id,
          transaction_id: sanitizedTxId,
          subject: fullSubject,
          description,
          status: 'OPEN',
        },
      });

      await SecurityService.recordEvent({
        userId: req.user.id,
        eventType: 'COMPLAINT_FILED',
        severity: 'LOW',
        description: `Dispute/Complaint submitted: ${fullSubject}`,
        ipAddress: req.ip,
        deviceReference: req.headers['user-agent'],
      });

      res.status(201).json({
        ok: true,
        message: 'Complaint submitted successfully. An administrator will review your case.',
        complaint: {
          id: complaint.id,
          subject: complaint.subject,
          description: complaint.description,
          status: complaint.status,
          adminResponse: complaint.admin_response,
          admin_response: complaint.admin_response,
          createdAt: complaint.created_at,
          created_at: complaint.created_at,
        },
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = ComplaintController;

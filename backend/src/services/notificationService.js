const prisma = require('../prisma');

async function list(userId, { unreadOnly = false, limit = 50 } = {}) {
  return prisma.notification.findMany({
    where: { user_id: userId, ...(unreadOnly ? { read: false } : {}) },
    orderBy: { created_at: 'desc' },
    take: Math.min(Math.max(Number(limit) || 50, 1), 100),
  });
}
async function markRead(userId, id) {
  const result = await prisma.notification.updateMany({
    where: { id, user_id: userId },
    data: { read: true },
  });
  if (!result.count) {
    const error = new Error('Notification not found.');
    error.status = 404;
    throw error;
  }
  return prisma.notification.findUnique({ where: { id } });
}
async function markAllRead(userId) {
  const result = await prisma.notification.updateMany({
    where: { user_id: userId, read: false },
    data: { read: true },
  });
  return { updated: result.count };
}
module.exports = { list, markRead, markAllRead };

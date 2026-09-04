const service = require('../services/notificationService');

async function getNotifications(req, res, next) {
  try {
    const notifications = await service.list(req.user.id, {
      unreadOnly: req.query.unreadOnly === 'true' || req.query.unread === 'true',
      limit: req.query.limit,
    });
    res.json({ ok: true, notifications, unreadCount: notifications.filter((n) => !n.read).length });
  } catch (err) {
    next(err);
  }
}
async function markRead(req, res, next) {
  try {
    res.json({ ok: true, notification: await service.markRead(req.user.id, req.params.id) });
  } catch (err) {
    next(err);
  }
}
async function markAllRead(req, res, next) {
  try {
    res.json({ ok: true, ...(await service.markAllRead(req.user.id)) });
  } catch (err) {
    next(err);
  }
}
module.exports = { getNotifications, markRead, markAllRead };

const AICopilotService = require('../services/aiCopilotService');

const aiCopilotService = new AICopilotService();

class AIController {
  static async chat(req, res, next) {
    try {
      const result = await aiCopilotService.chat(req.user.id, req.body.message);
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  }

  static async history(req, res, next) {
    try {
      const history = await aiCopilotService.history(req.user.id, req.query);
      res.json({ ok: true, history });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = AIController;

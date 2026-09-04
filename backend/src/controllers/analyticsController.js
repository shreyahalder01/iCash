const { getForecast } = require('../services/forecastService');
const { getHealthScore } = require('../services/healthScoreService');

async function forecast(req, res, next) {
  try {
    res.json({ ok: true, forecast: await getForecast(req.user.id, req.query) });
  } catch (err) {
    next(err);
  }
}
async function score(req, res, next) {
  try {
    res.json({ ok: true, healthScore: await getHealthScore(req.user.id) });
  } catch (err) {
    next(err);
  }
}
module.exports = { forecast, score };

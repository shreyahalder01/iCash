/**
 * SMS provider adapter. Picks an implementation based on SMS_PROVIDER
 * in .env, so swapping providers later means changing one env var,
 * not your route code.
 *
 * Every send*() function must return a Promise and throw on failure.
 */
const fetch = require('node-fetch');

const PROVIDER = process.env.SMS_PROVIDER || 'console';

async function sendViaConsole(mobile, code) {
  console.log(
    `\n[DEV MODE] Would send SMS to +91 ${mobile}: "Your iCash OTP is ${code}. Valid 5 minutes."\n`
  );
  return { devMode: true };
}

async function sendVia2Factor(mobile, code) {
  const apiKey = process.env.TWOFACTOR_API_KEY;
  if (!apiKey) throw new Error('TWOFACTOR_API_KEY is not set in .env');
  // 2Factor's OTP-with-your-own-code endpoint (SMS-only, no template needed).
  const url = `https://2factor.in/API/V1/${apiKey}/SMS/${mobile}/${code}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.Status !== 'Success') throw new Error('2Factor send failed: ' + JSON.stringify(data));
  return data;
}

async function sendViaMsg91(mobile, code) {
  const authKey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;
  if (!authKey || !templateId)
    throw new Error('MSG91_AUTH_KEY / MSG91_TEMPLATE_ID not set in .env');
  const url = 'https://control.msg91.com/api/v5/otp';
  const res = await fetch(
    `${url}?template_id=${templateId}&mobile=91${mobile}&otp=${code}&authkey=${authKey}`,
    {
      method: 'POST',
    }
  );
  const data = await res.json();
  if (data.type !== 'success') throw new Error('MSG91 send failed: ' + JSON.stringify(data));
  return data;
}

async function sendViaTwilio(mobile, code) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) throw new Error('Twilio env vars not fully set in .env');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const body = new URLSearchParams({
    To: `+91${mobile}`,
    From: from,
    Body: `Your iCash OTP is ${code}. Valid 5 minutes.`,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Twilio send failed: ' + JSON.stringify(data));
  return data;
}

const providers = {
  console: sendViaConsole,
  twofactor: sendVia2Factor,
  msg91: sendViaMsg91,
  twilio: sendViaTwilio,
};

async function sendOtpSms(mobile, code) {
  if (process.env.NODE_ENV === 'production' && PROVIDER === 'console') {
    throw new Error('Console SMS delivery is disabled in production.');
  }
  const send = providers[PROVIDER];
  if (!send) throw new Error(`Unknown SMS_PROVIDER "${PROVIDER}"`);
  return send(mobile, code);
}

function isDevMode() {
  return PROVIDER === 'console';
}

module.exports = { sendOtpSms, isDevMode, PROVIDER };

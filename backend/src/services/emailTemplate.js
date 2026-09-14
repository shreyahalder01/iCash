/**
 * Email Templates for iCash Digital Banking
 * Implements the email layout pattern from zahid-afridi/EmailVerfication
 */

const Verification_Email_Template = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verify Your iCash Email</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            margin: 0;
            padding: 0;
            background-color: #0b0f19;
            color: #f1f5f9;
        }
        .container {
            max-width: 580px;
            margin: 40px auto;
            background: #111827;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .header {
            background: linear-gradient(135deg, #0ea5e9 0%, #2563eb 100%);
            color: #ffffff;
            padding: 28px 20px;
            text-align: center;
        }
        .header h1 {
            margin: 0;
            font-size: 24px;
            font-weight: 700;
            letter-spacing: -0.5px;
        }
        .header p {
            margin: 6px 0 0;
            font-size: 13px;
            opacity: 0.9;
        }
        .content {
            padding: 32px 28px;
            color: #cbd5e1;
            line-height: 1.7;
        }
        .content p {
            margin: 0 0 16px;
            font-size: 15px;
        }
        .code-box {
            display: block;
            margin: 28px 0;
            background: rgba(14, 165, 233, 0.08);
            border: 1.5px dashed #0ea5e9;
            border-radius: 10px;
            padding: 16px;
            text-align: center;
        }
        .verification-code {
            font-size: 32px;
            color: #38bdf8;
            font-weight: 800;
            letter-spacing: 8px;
            font-family: 'Courier New', Courier, monospace;
        }
        .expiry-note {
            margin-top: 8px;
            font-size: 12px;
            color: #94a3b8;
        }
        .footer {
            background-color: #0d1321;
            padding: 20px 24px;
            text-align: center;
            color: #64748b;
            font-size: 12px;
            border-top: 1px solid rgba(255, 255, 255, 0.06);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>iCash Secure Banking</h1>
            <p>Cryptographic Identity Verification</p>
        </div>
        <div class="content">
            <p>Hello,</p>
            <p>Thank you for choosing iCash. To finalize your account setup and link your verified email address, please use the following one-time verification code:</p>
            
            <div class="code-box">
                <div class="verification-code">{verificationCode}</div>
                <div class="expiry-note">⏱ Valid for 24 hours. Do not share this code with anyone.</div>
            </div>

            <p>If you did not initiate this registration or account update, please ignore this email or contact iCash Security Support immediately.</p>
        </div>
        <div class="footer">
            <p>&copy; ${new Date().getFullYear()} iCash Digital Banking Corp. ISO 27001 Certified Core.</p>
        </div>
    </div>
</body>
</html>
`;

const Welcome_Email_Template = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to iCash Banking</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            margin: 0;
            padding: 0;
            background-color: #0b0f19;
            color: #f1f5f9;
        }
        .container {
            max-width: 580px;
            margin: 40px auto;
            background: #111827;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .header {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: #ffffff;
            padding: 28px 20px;
            text-align: center;
        }
        .header h1 {
            margin: 0;
            font-size: 24px;
            font-weight: 700;
        }
        .content {
            padding: 32px 28px;
            color: #cbd5e1;
            line-height: 1.7;
        }
        .welcome-title {
            font-size: 18px;
            font-weight: 600;
            color: #ffffff;
            margin-bottom: 12px;
        }
        .features-list {
            background: rgba(255, 255, 255, 0.03);
            border-radius: 8px;
            padding: 16px 20px;
            margin: 20px 0;
            list-style: none;
        }
        .features-list li {
            padding: 8px 0;
            display: flex;
            align-items: center;
            font-size: 14px;
            color: #94a3b8;
        }
        .features-list li strong {
            color: #38bdf8;
            margin-right: 6px;
        }
        .footer {
            background-color: #0d1321;
            padding: 20px 24px;
            text-align: center;
            color: #64748b;
            font-size: 12px;
            border-top: 1px solid rgba(255, 255, 255, 0.06);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Email Verified Successfully ✓</h1>
        </div>
        <div class="content">
            <div class="welcome-title">Welcome to iCash, {name}!</div>
            <p>Your email address has been verified and securely bound to your cryptographic biometric profile.</p>
            
            <ul class="features-list">
                <li><strong>👁️ BioGate:</strong> Instant passwordless facial login with liveness detection.</li>
                <li><strong>⚡ Instant Transfers:</strong> High-speed deposits, withdrawals, and merchant QR payments.</li>
                <li><strong>🛡️ AI Fraud Shield:</strong> Continuous transaction scoring and biometric step-up challenges.</li>
            </ul>

            <p>You can now manage all your digital assets and view transaction receipts directly from your dashboard.</p>
        </div>
        <div class="footer">
            <p>&copy; ${new Date().getFullYear()} iCash Digital Banking Corp. All rights reserved.</p>
        </div>
    </div>
</body>
</html>
`;

module.exports = {
  Verification_Email_Template,
  Welcome_Email_Template,
};

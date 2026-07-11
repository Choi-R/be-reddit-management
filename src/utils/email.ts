import { Env } from '../types';

/**
 * Sends a password reset email to the user using Resend.
 * In a Cloudflare Worker runtime, we use Resend's REST API via standard fetch
 * because traditional Node.js TCP socket SMTP libraries are incompatible/inefficient.
 */
export async function sendResetPasswordEmail(
  email: string,
  token: string,
  env: Env
): Promise<any> {
  const apiKey = env.RESEND_API_KEY || env.VITE_RESEND_API_KEY || (env.SMTP_HOST === 'smtp.resend.com' ? env.SMTP_PASSWORD : env.VITE_SMTP_HOST === 'smtp.resend.com' ? env.VITE_SMTP_PASSWORD : null);
  const fromEmail = env.SMTP_FROM || env.VITE_SMTP_FROM || 'onboarding@resend.dev';
  const frontendUrl = env.FRONTEND_URL || env.VITE_FRONTEND_URL || 'http://localhost:5173';
  const resetLink = `${frontendUrl}/reset-password?token=${token}`;
  const subject = 'Reset Your Reddit Tasks CRM Password';

  if (!apiKey) {
    console.warn('⚠️ EMAIL SENDING LOG (Development Mode): No Resend API Key configured.');
    console.log('--------------------------------------------------');
    console.log(`To: ${email}`);
    console.log(`Subject: ${subject}`);
    console.log(`Reset Link: ${resetLink}`);
    console.log('--------------------------------------------------');
    return { id: 'mock-email-id-dev-mode' };
  }

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Password</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background-color: #0b0f19;
      color: #e2e8f0;
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      background-color: #0b0f19;
      padding: 40px 0;
    }
    .container {
      max-width: 580px;
      margin: 0 auto;
      background: rgba(17, 24, 39, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    }
    .header {
      padding: 30px;
      text-align: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%);
    }
    .header h1 {
      margin: 0;
      font-size: 24px;
      color: #3b82f6;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .content {
      padding: 40px 30px;
      line-height: 1.6;
    }
    .content p {
      margin: 0 0 20px 0;
      font-size: 16px;
      color: #94a3b8;
    }
    .btn-container {
      text-align: center;
      margin: 35px 0;
    }
    .btn {
      display: inline-block;
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
      color: #ffffff !important;
      text-decoration: none;
      padding: 14px 30px;
      font-size: 16px;
      font-weight: 600;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
      transition: all 0.2s ease;
    }
    .footer {
      padding: 20px 30px;
      background-color: rgba(15, 23, 42, 0.6);
      text-align: center;
      font-size: 13px;
      color: #64748b;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }
    .footer a {
      color: #3b82f6;
      text-decoration: none;
    }
    @media only screen and (max-width: 600px) {
      .container {
        border-radius: 0;
        border: none;
      }
      .content {
        padding: 30px 20px;
      }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <h1>Reddit Tasks CRM</h1>
      </div>
      <div class="content">
        <p>Hello,</p>
        <p>We received a request to reset the password associated with your account. Click the button below to choose a new password. This reset link is valid for <strong>1 hour</strong>.</p>
        
        <div class="btn-container">
          <a href="${resetLink}" class="btn" target="_blank">Reset Password</a>
        </div>
        
        <p>If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
        <p>Best regards,<br>Reddit Tasks CRM Team</p>
      </div>
      <div class="footer">
        <p>This is an automated security transmission. Please do not reply directly to this email.</p>
        <p>&copy; 2026 Reddit Tasks CRM. All rights reserved.</p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [email],
      subject: subject,
      html: htmlContent,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Resend API response error (${response.status}):`, errorText);
    throw new Error(`Email delivery failed: ${errorText}`);
  }

  const result = (await response.json()) as any;
  console.log(`Password reset email successfully sent to ${email}. ID:`, result.id);
  return result;
}

import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'localhost',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  } : undefined
});

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(options: EmailOptions): Promise<boolean> {
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || 'Bosun <noreply@localhost>',
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text
    });
    console.log('[Email] Sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('Email failed:', error);
    return false;
  }
}

export async function sendAlertEmail(to: string, alertName: string, message: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: `[Alert] ${alertName}`,
    html: `<h2>${alertName}</h2><p>${message}</p>`,
    text: `[Alert] ${alertName}: ${message}`
  });
}
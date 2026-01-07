const nodemailer = require('nodemailer');
const EmailLog = require('../models/EmailLog');

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: process.env.EMAIL_PORT == 465, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/**
 * Sends an email.
 * @param {string} to - The recipient's email address.
 * @param {string} subject - The subject of the email.
 * @param {string} html - The HTML body of the email.
 */
const sendEmail = async ({ seasonId, to, subject, html }) => {
    try {
    const info = await transporter.sendMail({
      from: `"PRODUCTION Timeline" <${process.env.EMAIL_FROM}>`,
      to,
      subject,
      html,
    });

    console.log('Message sent: %s', info.messageId);
    await EmailLog.create({
      season: seasonId,
      recipient: to,
      subject,
      status: 'sent',
    });

    return info;
  } catch (error) {
    console.error('Error sending email:', error);
    await EmailLog.create({
      season: seasonId,
      recipient: to,
      subject,
      status: 'failed',
      error: error.message,
    });
    // We still throw the error so the calling function knows about the failure,
    // but the failure is now logged.
    throw new Error(`Failed to send email to ${to}: ${error.message}`);
  }
};

module.exports = { sendEmail };

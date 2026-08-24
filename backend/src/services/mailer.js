// mailer.js — QR generation + email delivery.
// If SMTP_* env vars are blank, we auto-create a free Ethereal test inbox
// on boot (no signup required) and log a preview URL for every mail sent,
// so the whole flow is demoable with zero configuration. Swap in real
// SMTP creds (Gmail app password / SendGrid / Mailtrap / Resend free
// tiers all work) for production — no code changes needed, just .env.
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

let transporterPromise = null;

async function getTransporter() {
  if (transporterPromise) return transporterPromise;
  transporterPromise = (async () => {
    if (process.env.SMTP_HOST) {
      return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: false,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      });
    }
    const testAccount = await nodemailer.createTestAccount();
    console.log('[mailer] No SMTP configured — using a free Ethereal test inbox.');
    console.log(`[mailer] Login: ${testAccount.user} / ${testAccount.pass} (https://ethereal.email)`);
    return nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
  })();
  return transporterPromise;
}

async function generateQrDataUrl(text) {
  return QRCode.toDataURL(text, { margin: 1, width: 320 });
}

async function sendBookingConfirmation({ to, name, refCode, showTitle, dateTime, seats, total, qrDataUrl }) {
  const transporter = await getTransporter();
  const seatList = seats.map(s => `${s.section} ${s.row}${s.number} (${s.category})`).join(', ');
  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || 'Ticketron <no-reply@ticketron.dev>',
    to,
    subject: `Your ticket is confirmed — ${refCode}`,
    html: `
      <h2>You're in, ${name}.</h2>
      <p><strong>${showTitle}</strong><br/>${dateTime}</p>
      <p>Seats: ${seatList}<br/>Total: ₹${total}</p>
      <p>Booking reference: <strong>${refCode}</strong></p>
      <p>Show this QR code at the entrance:</p>
      <img src="${qrDataUrl}" alt="QR ticket" width="220" height="220"/>
    `,
  });
  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) console.log(`[mailer] Preview: ${preview}`);
  return { messageId: info.messageId, previewUrl: preview || null };
}

async function sendWaitlistOffer({ to, name, showTitle, category, expiresAt, offerLink }) {
  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || 'Ticketron <no-reply@ticketron.dev>',
    to,
    subject: `A ${category} seat just opened up for ${showTitle}`,
    html: `
      <h2>Hi ${name}, a seat is yours if you want it.</h2>
      <p>A <strong>${category}</strong> seat for <strong>${showTitle}</strong> opened up and you're next on the waitlist.</p>
      <p>This offer holds the seat until <strong>${new Date(expiresAt).toLocaleString()}</strong>. After that it moves to the next person in line.</p>
      <p><a href="${offerLink}">Complete your booking</a></p>
    `,
  });
  const preview = nodemailer.getTestMessageUrl(info);
  if (preview) console.log(`[mailer] Preview: ${preview}`);
  return { messageId: info.messageId, previewUrl: preview || null };
}

module.exports = { generateQrDataUrl, sendBookingConfirmation, sendWaitlistOffer };

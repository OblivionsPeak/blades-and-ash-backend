import { Resend } from 'resend';
import 'dotenv/config';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendAppointmentReminder({ to, clientName, serviceName, staffName, startTime }) {
  const dateStr = new Date(startTime).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const { data, error } = await resend.emails.send({
    from: 'Blades & Ash Studio <noreply@bladesandash.com>',
    to,
    subject: `Reminder: Your appointment at Blades & Ash Studio`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#2A2A2A">Appointment Reminder</h2>
        <p>Hi ${clientName},</p>
        <p>This is a reminder for your upcoming appointment:</p>
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:8px 0;color:#888">Service</td>
            <td style="padding:8px 0;font-weight:600">${serviceName}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#888">Stylist</td>
            <td style="padding:8px 0;font-weight:600">${staffName}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#888">Date &amp; Time</td>
            <td style="padding:8px 0;font-weight:600">${dateStr}</td>
          </tr>
        </table>
        <p style="color:#888;font-size:14px">Need to cancel or reschedule? Please contact us as soon as possible.</p>
        <p style="color:#C4A882;font-weight:600">Blades &amp; Ash Studio</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Failed to send reminder email: ${error.message}`);
  }

  return data;
}

export async function sendBookingConfirmation({
  to,
  clientName,
  serviceName,
  staffName,
  startTime,
  totalCents,
  depositCents,
}) {
  const dateStr = new Date(startTime).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const total = (totalCents / 100).toFixed(2);
  const deposit = depositCents ? (depositCents / 100).toFixed(2) : null;

  const { data, error } = await resend.emails.send({
    from: 'Blades & Ash Studio <noreply@bladesandash.com>',
    to,
    subject: 'Booking Confirmed — Blades & Ash Studio',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#2A2A2A">Booking Confirmed!</h2>
        <p>Hi ${clientName}, your appointment has been confirmed.</p>
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:8px 0;color:#888">Service</td>
            <td style="padding:8px 0;font-weight:600">${serviceName}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#888">Stylist</td>
            <td style="padding:8px 0;font-weight:600">${staffName}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#888">Date &amp; Time</td>
            <td style="padding:8px 0;font-weight:600">${dateStr}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#888">Total</td>
            <td style="padding:8px 0;font-weight:600">$${total}</td>
          </tr>
          ${
            deposit
              ? `<tr>
            <td style="padding:8px 0;color:#888">Deposit paid</td>
            <td style="padding:8px 0;font-weight:600">$${deposit}</td>
          </tr>`
              : ''
          }
        </table>
        <p style="margin-top:24px;color:#888;font-size:14px">
          Need to cancel or reschedule? Please contact us at least 24 hours in advance.
        </p>
        <p style="color:#C4A882;font-weight:600">Blades &amp; Ash Studio</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Failed to send confirmation email: ${error.message}`);
  }

  return data;
}

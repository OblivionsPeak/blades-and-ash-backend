import { Resend } from 'resend';
import 'dotenv/config';

const resend = new Resend(process.env.RESEND_API_KEY);

// Branded sender. Override with RESEND_FROM once the bladeandash.com domain is
// verified in Resend. Defaults to the branded address (the domain still needs
// verification in Resend for delivery — that's a separate human step).
const FROM_ADDRESS = process.env.RESEND_FROM || 'Blades & Ash <bookings@bladeandash.com>';

// Where new-booking alerts go. Defaults to the salon owner; override per-deploy.
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'owner@bladeandash.com';

// Guest-supplied values (names, etc.) end up in these templates — escape them
// so a crafted booking can't inject HTML into mail sent from our domain.
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
    from: FROM_ADDRESS,
    to,
    subject: `Reminder: Your appointment at Blades & Ash Studio`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#2A2A2A">Appointment Reminder</h2>
        <p>Hi ${esc(clientName)},</p>
        <p>This is a reminder for your upcoming appointment:</p>
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:8px 0;color:#888">Service</td>
            <td style="padding:8px 0;font-weight:600">${esc(serviceName)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#888">Stylist</td>
            <td style="padding:8px 0;font-weight:600">${esc(staffName)}</td>
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
  // Amount the client paid online (deposit or full). When > 0, paymentLabel
  // names what it was ('Deposit paid' / 'Paid in full'). null/0 => pay-at-salon.
  amountPaidCents = null,
  paymentLabel = 'Deposit paid',
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
  const paid = amountPaidCents ? (amountPaidCents / 100).toFixed(2) : null;

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: 'Booking Confirmed — Blades & Ash Studio',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#2A2A2A">Booking Confirmed!</h2>
        <p>Hi ${esc(clientName)}, your appointment has been confirmed.</p>
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:8px 0;color:#888">Service</td>
            <td style="padding:8px 0;font-weight:600">${esc(serviceName)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#888">Stylist</td>
            <td style="padding:8px 0;font-weight:600">${esc(staffName)}</td>
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
            paid
              ? `<tr>
            <td style="padding:8px 0;color:#888">${esc(paymentLabel)}</td>
            <td style="padding:8px 0;font-weight:600">$${paid}</td>
          </tr>`
              : ''
          }
        </table>
        <p style="margin-top:24px;color:#888;font-size:14px">
          Need to cancel or reschedule? Please contact us at least 24 hours in advance.
        </p>
        <p style="margin-top:16px;color:#888;font-size:13px;line-height:1.5">
          Cancellation policy: Cancellations within 48 hours of your appointment are charged 50% of the service. No-shows are charged 100% of the service.
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

// Notifies the salon owner that a booking is now secured. Fired from the same
// points as the client confirmation: the instant-confirm path (no payment due)
// and the Stripe webhook (after a deposit / full payment succeeds). Client-
// supplied values are escaped — they render in mail sent from our domain.
export async function sendOwnerBookingAlert({
  clientName,
  clientEmail,
  clientPhone,
  serviceName,
  staffName,
  startTime,
  totalCents,
  amountPaidCents = null,
  paymentLabel = 'Deposit paid',
  notes,
  isGuest = false,
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
  const paid = amountPaidCents ? (amountPaidCents / 100).toFixed(2) : null;
  const payStatus = paid ? `${paymentLabel} — $${paid}` : 'Nothing collected online (pay at salon)';

  function row(label, value) {
    return `<tr>
            <td style="padding:8px 0;color:#888">${esc(label)}</td>
            <td style="padding:8px 0;font-weight:600">${value}</td>
          </tr>`;
  }

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: OWNER_EMAIL,
    // Reply lands in the client's inbox so Holly can respond in one tap.
    reply_to: clientEmail || undefined,
    subject: `New booking: ${esc(clientName)} — ${dateStr}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#2A2A2A">New Booking</h2>
        <p>${esc(clientName)}${isGuest ? ' (guest)' : ''} just booked an appointment.</p>
        <table style="width:100%;border-collapse:collapse">
          ${row('Client', esc(clientName))}
          ${clientEmail ? row('Email', esc(clientEmail)) : ''}
          ${clientPhone ? row('Phone', esc(clientPhone)) : ''}
          ${row('Service', esc(serviceName))}
          ${row('Stylist', esc(staffName))}
          ${row('Date &amp; Time', dateStr)}
          ${row('Total', `$${total}`)}
          ${row('Payment', esc(payStatus))}
          ${notes ? row('Notes', esc(notes)) : ''}
        </table>
        <p style="color:#C4A882;font-weight:600;margin-top:24px">Blades &amp; Ash Studio</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Failed to send owner booking alert: ${error.message}`);
  }

  return data;
}

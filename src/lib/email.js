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
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The salon is in Central time. Format appointment times in that zone so emails
// don't render in the server's UTC. 'America/Chicago' tracks CST/CDT automatically,
// so timeZoneName: 'short' shows the correct CST/CDT label. Override per-deploy if needed.
const SALON_TZ = process.env.SALON_TIMEZONE || 'America/Chicago';

function formatApptTime(startTime) {
  return new Date(startTime).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: SALON_TZ,
    timeZoneName: 'short',
  });
}

export async function sendAppointmentReminder({ to, clientName, serviceName, staffName, startTime }) {
  const dateStr = formatApptTime(startTime);

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
  const dateStr = formatApptTime(startTime);

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
          Need to cancel or reschedule? Please let us know at least 72 hours in advance.
        </p>
        <p style="margin-top:16px;color:#888;font-size:13px;line-height:1.5">
          Cancellation policy: Cancellations made less than 72 hours before your appointment are charged 50% of the service. Same-day cancellations and no-shows are charged 100% of the service, to the card on file.
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
  const dateStr = formatApptTime(startTime);

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

// ──────────────────────────────────────────────────────────
// Client forms (waiver + consultation)
// ──────────────────────────────────────────────────────────

function formatSignedAt(when) {
  return new Date(when).toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: SALON_TZ,
    timeZoneName: 'short',
  });
}

// Heads-up to the owner that a form landed. Deliberately light: the full
// answers live in Admin → Forms, and a consultation can hold health details
// that don't belong in an inbox.
export async function sendOwnerFormAlert({ kind, clientName, clientEmail, clientPhone, submittedAt, adminUrl }) {
  const label = kind === 'waiver' ? 'Signed waiver' : 'Consultation form';

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: OWNER_EMAIL,
    reply_to: clientEmail || undefined,
    subject: `${label}: ${esc(clientName)}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#2A2A2A">${esc(label)}</h2>
        <p>${esc(clientName)} just submitted the ${kind === 'waiver' ? 'Client Service Agreement &amp; Waiver' : 'Client Consultation form'}.</p>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#888">Client</td><td style="padding:8px 0;font-weight:600">${esc(clientName)}</td></tr>
          ${clientEmail ? `<tr><td style="padding:8px 0;color:#888">Email</td><td style="padding:8px 0;font-weight:600">${esc(clientEmail)}</td></tr>` : ''}
          ${clientPhone ? `<tr><td style="padding:8px 0;color:#888">Phone</td><td style="padding:8px 0;font-weight:600">${esc(clientPhone)}</td></tr>` : ''}
          <tr><td style="padding:8px 0;color:#888">Submitted</td><td style="padding:8px 0;font-weight:600">${esc(formatSignedAt(submittedAt))}</td></tr>
        </table>
        ${adminUrl ? `<p style="margin-top:20px"><a href="${esc(adminUrl)}" style="color:#9A7531;font-weight:600">Open it in Admin → Forms</a></p>` : ''}
        <p style="color:#C4A882;font-weight:600;margin-top:24px">Blades &amp; Ash Studio</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Failed to send owner form alert: ${error.message}`);
  }

  return data;
}

// The client's copy of what they signed: full agreement text, their printed
// name, the signature image, and the timestamp. `sections` is the same
// WAIVER_SECTIONS array the website rendered, so the copy matches exactly.
export async function sendWaiverCopy({
  to,
  clientName,
  guardianName,
  signedAt,
  version,
  signatureDataUrl,
  title,
  intro,
  sections,
}) {
  const sectionHtml = (sections || [])
    .map(
      (s) => `
        <h3 style="font-size:14px;margin:20px 0 6px;color:#2A2A2A">${esc(s.title)}</h3>
        <p style="margin:0;color:#444;font-size:13px;line-height:1.6">${esc(s.body)}</p>
        ${
          s.bullets && s.bullets.length
            ? `<ul style="margin:8px 0 0 18px;padding:0;color:#444;font-size:13px;line-height:1.6">${s.bullets
                .map((b) => `<li>${esc(b)}</li>`)
                .join('')}</ul>`
            : ''
        }`
    )
    .join('');

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: 'Your signed agreement — Blades & Ash Studio',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2 style="color:#2A2A2A;margin-bottom:4px">Blades &amp; Ash Studio</h2>
        <p style="color:#888;margin-top:0;font-size:13px">${esc(title)}</p>
        <p>Hi ${esc(clientName)}, here is your copy of the agreement you signed. Keep it for your records.</p>
        <p style="color:#444;font-size:13px;line-height:1.6">${esc(intro)}</p>
        ${sectionHtml}
        <hr style="border:none;border-top:1px solid #ddd;margin:28px 0" />
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td style="padding:6px 0;color:#888;width:160px">Client name (printed)</td><td style="padding:6px 0;font-weight:600">${esc(clientName)}</td></tr>
          ${guardianName ? `<tr><td style="padding:6px 0;color:#888">Parent / guardian</td><td style="padding:6px 0;font-weight:600">${esc(guardianName)}</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#888">Signed</td><td style="padding:6px 0;font-weight:600">${esc(formatSignedAt(signedAt))}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Agreement version</td><td style="padding:6px 0">${esc(version)}</td></tr>
        </table>
        ${signatureDataUrl ? `<p style="margin:16px 0 4px;color:#888;font-size:12px">Signature</p><img src="${signatureDataUrl}" alt="Signature" style="max-width:320px;border:1px solid #ddd;border-radius:6px;background:#fff" />` : ''}
        <p style="color:#C4A882;font-weight:600;margin-top:28px">Blades &amp; Ash Studio</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Failed to send waiver copy: ${error.message}`);
  }

  return data;
}

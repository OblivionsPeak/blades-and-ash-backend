import twilio from 'twilio';
import 'dotenv/config';

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export async function sendSmsReminder({ to, clientName, serviceName, startTime }) {
  const dateStr = new Date(startTime).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const message = await client.messages.create({
    body: `Hi ${clientName}! Reminder: ${serviceName} at Blades & Ash Studio — ${dateStr}. Questions? Reply to this message.`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  });

  return message;
}

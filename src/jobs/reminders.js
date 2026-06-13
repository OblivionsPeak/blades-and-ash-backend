import cron from 'node-cron';
import { supabase } from '../supabase.js';
import { sendAppointmentReminder } from '../lib/email.js';
import { sendSmsReminder } from '../lib/sms.js';

// In-process guard so two overlapping triggers (e.g. a slow sweep plus the
// next external ping) can't double-send the same reminder. Single web
// instance on Render, so a module-level flag is sufficient.
let isRunning = false;

/**
 * Process pending reminders.
 * For each pending reminder, check if it's time to send based on
 * appointment start_time and reminder type ('24h' or '2h').
 * Returns a summary; safe to call concurrently (no-ops if already running).
 */
export async function processReminders() {
  if (isRunning) {
    console.log('[reminders] Sweep already in progress — skipping this trigger.');
    return { skipped: true, reason: 'already_running' };
  }
  isRunning = true;
  console.log('[reminders] Running reminder check at', new Date().toISOString());

  let sent = 0;
  let failed = 0;
  try {
    // Fetch all pending reminders joined with appointment + client + service + staff
    const { data: reminders, error } = await supabase
      .from('reminders')
      .select(`
        id,
        type,
        channel,
        status,
        appointment_id,
        appointment:appointments(
          id,
          start_time,
          status,
          client_id,
          staff_id,
          guest_name,
          guest_email,
          guest_phone,
          client:profiles!appointments_client_id_fkey(id, full_name, phone),
          staff:profiles!appointments_staff_id_fkey(id, full_name),
          service:services!appointments_service_id_fkey(id, name)
        )
      `)
      .eq('status', 'pending')
      .is('sent_at', null);

    if (error) {
      console.error('[reminders] Failed to fetch reminders:', error.message);
      return { processed: 0, sent, error: error.message };
    }

    if (!reminders || reminders.length === 0) {
      console.log('[reminders] No pending reminders found.');
      return { processed: 0, sent };
    }

    const now = Date.now();

    for (const reminder of reminders) {
      const appointment = reminder.appointment;

      // Skip if appointment doesn't exist or is cancelled/completed
      if (!appointment) {
        await markReminder(reminder.id, 'failed');
        continue;
      }

      if (['cancelled', 'completed', 'no_show'].includes(appointment.status)) {
        // Cancel this reminder since appointment is no longer active
        await markReminder(reminder.id, 'failed');
        continue;
      }

      const startTime = new Date(appointment.start_time).getTime();
      const hoursOffset = reminder.type === '24h' ? 24 : 2;
      const sendAfter = startTime - hoursOffset * 60 * 60 * 1000;

      // Only send if we're past the "send after" time and the appointment is in the future
      if (now < sendAfter) {
        // Not yet time to send
        continue;
      }

      if (now > startTime) {
        // Appointment already started — mark as failed
        await markReminder(reminder.id, 'failed');
        continue;
      }

      // Gather required data
      const clientProfile = appointment.client;
      const staffProfile = appointment.staff;
      const service = appointment.service;

      // A guest booking (client_id null) has no client profile join; it carries
      // its contact details on the appointment row instead.
      const isGuest = !appointment.client_id;

      if ((!clientProfile && !isGuest) || !service) {
        await markReminder(reminder.id, 'failed');
        continue;
      }

      const reminderClientName = isGuest
        ? (appointment.guest_name || 'Valued Client')
        : clientProfile.full_name;

      try {
        if (reminder.channel === 'email') {
          // Resolve the recipient email: signed-in clients from auth.users,
          // guests from the stored guest_email.
          let to = null;
          if (isGuest) {
            to = appointment.guest_email || null;
          } else {
            const { data: userData, error: userError } = await supabase.auth.admin.getUserById(
              appointment.client_id
            );
            if (!userError) to = userData?.user?.email || null;
          }

          if (!to) {
            console.error(`[reminders] Could not find email for appointment ${appointment.id}`);
            await markReminder(reminder.id, 'failed');
            continue;
          }

          await sendAppointmentReminder({
            to,
            clientName: reminderClientName,
            serviceName: service.name,
            staffName: staffProfile?.full_name || 'Your stylist',
            startTime: appointment.start_time,
          });
        } else if (reminder.channel === 'sms') {
          // SMS disabled until Twilio 10DLC registration is complete
          await markReminder(reminder.id, 'failed');
          continue;
        }

        // Mark as sent
        await supabase
          .from('reminders')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', reminder.id);

        sent += 1;
        console.log(`[reminders] Sent ${reminder.type} ${reminder.channel} reminder for appointment ${appointment.id}`);
      } catch (sendError) {
        console.error(
          `[reminders] Failed to send ${reminder.type} ${reminder.channel} reminder for appointment ${appointment.id}:`,
          sendError.message
        );
        failed += 1;
        await markReminder(reminder.id, 'failed');
      }
    }

    return { processed: reminders.length, sent, failed };
  } catch (err) {
    console.error('[reminders] Unexpected error in processReminders:', err.message);
    return { processed: 0, sent, failed, error: err.message };
  } finally {
    isRunning = false;
  }
}

async function markReminder(reminderId, status) {
  const { error } = await supabase
    .from('reminders')
    .update({ status, sent_at: status === 'sent' ? new Date().toISOString() : null })
    .eq('id', reminderId);

  if (error) {
    console.error(`[reminders] Failed to update reminder ${reminderId} to status=${status}:`, error.message);
  }
}

export function startReminderJob() {
  // On Render's free tier the web service sleeps when idle, so an in-process
  // cron is unreliable — set REMINDERS_TRIGGER=external and drive the sweep
  // from an external scheduler hitting POST /api/internal/run-reminders.
  // (Skipping the in-process cron also avoids double-sending.)
  if (process.env.REMINDERS_TRIGGER === 'external') {
    console.log('[reminders] External trigger mode — in-process cron disabled. Expecting POST /api/internal/run-reminders.');
    return;
  }

  // Default: in-process cron every 5 minutes (fine on an always-on instance).
  cron.schedule('*/5 * * * *', processReminders, {
    scheduled: true,
    timezone: 'America/New_York',
  });

  console.log('[reminders] Reminder cron job started — runs every 5 minutes.');
}

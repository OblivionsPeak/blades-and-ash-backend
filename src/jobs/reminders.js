import cron from 'node-cron';
import { supabase } from '../supabase.js';
import { sendAppointmentReminder } from '../lib/email.js';
import { sendSmsReminder } from '../lib/sms.js';

/**
 * Process pending reminders.
 * Runs every 5 minutes.
 * For each pending reminder, check if it's time to send based on
 * appointment start_time and reminder type ('24h' or '2h').
 */
async function processReminders() {
  console.log('[reminders] Running reminder check at', new Date().toISOString());

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
          client:profiles!appointments_client_id_fkey(id, full_name, phone, email:id),
          staff:profiles!appointments_staff_id_fkey(id, full_name),
          service:services!appointments_service_id_fkey(id, name)
        )
      `)
      .eq('status', 'pending')
      .is('sent_at', null);

    if (error) {
      console.error('[reminders] Failed to fetch reminders:', error.message);
      return;
    }

    if (!reminders || reminders.length === 0) {
      console.log('[reminders] No pending reminders found.');
      return;
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

        console.log(`[reminders] Sent ${reminder.type} ${reminder.channel} reminder for appointment ${appointment.id}`);
      } catch (sendError) {
        console.error(
          `[reminders] Failed to send ${reminder.type} ${reminder.channel} reminder for appointment ${appointment.id}:`,
          sendError.message
        );
        await markReminder(reminder.id, 'failed');
      }
    }
  } catch (err) {
    console.error('[reminders] Unexpected error in processReminders:', err.message);
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
  // Run every 5 minutes
  cron.schedule('*/5 * * * *', processReminders, {
    scheduled: true,
    timezone: 'America/New_York',
  });

  console.log('[reminders] Reminder cron job started — runs every 5 minutes.');
}

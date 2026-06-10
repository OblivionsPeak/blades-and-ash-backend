# Blades & Ash Studio — Backend API

Node.js + Express backend for the Blades & Ash Studio salon booking platform. Handles authentication, appointments, availability, payments, and automated reminders.

## Stack

- **Runtime:** Node.js (ES Modules)
- **Framework:** Express
- **Database & Auth:** Supabase (PostgreSQL)
- **Payments:** Stripe
- **Email:** Resend
- **SMS:** Twilio
- **Reminders:** node-cron
- **Deployment:** Render

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /health | None | Health check |
| GET | /api/services | None | List active services |
| POST | /api/services | Admin | Create service |
| PUT | /api/services/:id | Admin | Update service |
| DELETE | /api/services/:id | Admin | Deactivate service |
| GET | /api/staff | None | List staff profiles |
| GET | /api/staff/:id/availability | None | Get staff weekly availability |
| PUT | /api/staff/:id/availability | Staff/Admin | Set weekly availability |
| GET | /api/staff/:id/services | None | Services offered by staff member |
| POST | /api/staff/:id/services | Admin | Assign service to staff |
| DELETE | /api/staff/:id/services/:service_id | Admin | Remove service from staff |
| GET | /api/availability | None | Get available slots for a date |
| GET | /api/appointments | Auth | List appointments (role-filtered) |
| POST | /api/appointments | Auth | Book appointment |
| GET | /api/appointments/:id | Auth | Get single appointment |
| PUT | /api/appointments/:id | Staff/Admin | Update appointment |
| DELETE | /api/appointments/:id | Auth | Cancel appointment |
| POST | /api/payments/create-intent | Auth | Create Stripe PaymentIntent |
| POST | /api/webhooks/stripe | None (signed) | Stripe webhook handler |
| GET | /api/admin/dashboard | Admin/Staff | Dashboard stats |
| GET | /api/admin/appointments | Admin/Staff | All appointments (with filters) |
| GET | /api/admin/clients | Admin | List all clients |
| PUT | /api/admin/profiles/:id/role | Admin | Change user role |

## Setup Guide

### 1. Supabase

1. Go to [supabase.com](https://supabase.com) and create a new project.
2. In the Supabase dashboard, go to **SQL Editor** and run the contents of `supabase/schema.sql`.
3. From **Project Settings → API**, copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon/public key** → `SUPABASE_ANON_KEY`
   - **service_role key** → `SUPABASE_SERVICE_ROLE_KEY`

### 2. Stripe

1. Go to [stripe.com](https://stripe.com) and create/log into your account.
2. From **Developers → API Keys**, copy the **Secret key** → `STRIPE_SECRET_KEY`.
3. From **Developers → Webhooks**, click **Add endpoint**:
   - URL: `https://your-render-app.onrender.com/api/webhooks/stripe`
   - Events to listen for: `payment_intent.succeeded`, `payment_intent.payment_failed`
4. After creating the endpoint, copy the **Signing secret** → `STRIPE_WEBHOOK_SECRET`.

### 3. Resend (Email)

1. Go to [resend.com](https://resend.com) and create an account.
2. Verify your sending domain (or use the sandbox for testing).
3. From **API Keys**, create a new key → `RESEND_API_KEY`.
4. Update the `from` address in `src/lib/email.js` if needed.

### 4. Twilio (SMS)

1. Go to [twilio.com](https://twilio.com) and create an account.
2. From the **Console Dashboard**, copy:
   - **Account SID** → `TWILIO_ACCOUNT_SID`
   - **Auth Token** → `TWILIO_AUTH_TOKEN`
3. Buy a phone number (ensure it's SMS-capable) → `TWILIO_PHONE_NUMBER`.

### 5. Local Development

```bash
# Clone the repo
git clone https://github.com/OblivionsPeak/blades-and-ash-backend.git
cd blades-and-ash-backend

# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env
# Edit .env with your actual keys

# Start in development mode (with nodemon)
npm run dev
```

The API will be available at `http://localhost:3001`.

### 6. Deploy to Render

1. Go to [render.com](https://render.com) and log in.
2. Click **New → Blueprint**.
3. Connect your GitHub account and select the `OblivionsPeak/blades-and-ash-backend` repository.
4. Render will detect `render.yaml` and configure the service automatically.
5. Fill in all environment variables in the Render dashboard when prompted:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `RESEND_API_KEY`
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_PHONE_NUMBER`
   - `FRONTEND_URL`
6. Click **Apply** and wait for the deploy to complete.
7. Update your Stripe webhook URL to the Render-provided URL.

### 7. Create Your First Admin User

1. Sign up via the Blades & Ash Studio frontend app.
2. Go to the Supabase dashboard → **Table Editor** → `profiles` table.
3. Find the row for your user and change `role` from `client` to `admin`.
4. From now on, use the admin endpoints to manage staff roles via `PUT /api/admin/profiles/:id/role`.

## Environment Variables Reference

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3001) |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon/public key (for JWT verification) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (for server-side DB access) |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `RESEND_API_KEY` | Resend API key for sending emails |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_PHONE_NUMBER` | Twilio phone number to send SMS from |
| `FRONTEND_URL` | Frontend URL for CORS (e.g. https://blades-and-ash.vercel.app) |

## Monetary Values

All monetary values throughout the API are stored and transmitted as **integer cents** (e.g., $25.00 = `2500`). Never use floats for money.

## Reminder System

The reminder cron job (`src/jobs/reminders.js`) runs every 5 minutes and:
- Queries all `pending` reminders where `sent_at IS NULL`
- Sends 24-hour and 2-hour before-appointment reminders via email and SMS
- Marks reminders as `sent` or `failed` accordingly
- Skips reminders for cancelled/completed appointments

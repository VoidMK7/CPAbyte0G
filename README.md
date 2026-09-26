# HillsByte Proof Management Bot

A separate proof-review backend for the HillsByte ecosystem. It is not the main earning/task application.

## What it does

- Receives screenshot proofs from the Base44/main application.
- Stores all persistent records in Supabase PostgreSQL.
- Stores private screenshots in Supabase Storage.
- Provides a Telegram Mini App for users to submit screenshots and a mobile-first reviewer web panel for authorized reviewers.
- Provides Telegram inline-keyboard review tools.
- Supports owner/moderator roles.
- Approves/rejects proofs with structured rejection reasons.
- Sends review outcomes back to Base44.
- Retrieves user profiles/history/activity from the main app.
- Audits destructive/admin actions.
- Permanently deletes reviewed proofs and their screenshots.
- Survives Render restarts because no persistent data is stored locally.

## Project structure

```text
.
├── public/
│   ├── index.html
│   ├── app.css
│   └── app.js
├── API.md
├── README.md
├── schema.sql
├── server.js
├── package.json
├── render.yaml
├── .env.example
└── .gitignore
```

## 1. Supabase setup

Create a Supabase project, open SQL Editor, and run `schema.sql`.

The schema creates:
- users
- proof_submissions
- proof_metadata
- proof_reviews
- moderators
- broadcasts
- admin_messages
- audit_logs

It also creates the private `task-proofs` storage bucket.

Never expose the service-role key to the browser.

## 2. Environment variables

Copy `.env.example` to `.env` locally.

Required:
- `TELEGRAM_BOT_TOKEN`
- `ADMIN_ID`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MAIN_APP_API_URL`
- `MAIN_APP_API_SECRET`

Optional:
- `MODERATOR_IDS` is useful for bootstrapping additional moderators. The owner can manage the database-backed moderator list afterward.
- `PUBLIC_BASE_URL`
- `ADMIN_WEB_SECRET`

`ADMIN_ID` is the owner Telegram ID. The owner is always treated as role OWNER.

## 3. Run locally

```bash
npm install
npm start
```

Health:
`GET /health`

The Proof Center is served at `/`. The bot automatically sends a Telegram `web_app` button and configures the bot menu when `PUBLIC_BASE_URL` is set. Do not use a plain reply-keyboard text button.

The page must be opened from Telegram so `Telegram.WebApp.initData` exists. The server verifies that signed data before returning user/admin access.

## 4. Base44 integration

The Base44 server/integration should send:

```http
POST /api/proofs
Authorization: Bearer YOUR_MAIN_APP_API_SECRET
Content-Type: multipart/form-data
```

with the screenshot in the `screenshot` field.

Do not call the proof service from an untrusted public frontend with the shared secret. Proxy the submission through a trusted Base44 backend/integration layer.

After review, this service calls:

```http
POST MAIN_APP_API_URL/api/proof-result
Authorization: Bearer YOUR_MAIN_APP_API_SECRET
```

The Base44 app should use the `submission_id` to update the correct task.

## 5. Render

Create a Render Web Service from this GitHub repository.

Build command:
```bash
npm install
```

Start command:
```bash
npm start
```

Health check:
```text
/health
```

The server listens on `process.env.PORT`.

Add every variable from `.env.example` in Render Environment Variables.

## 6. Security model

- Supabase service role exists only on the Node server.
- Telegram bot token exists only on the Node server.
- Proof bucket is private.
- Screenshot viewing uses short-lived signed URLs.
- Main app requests use a bearer secret.
- Admin web access uses Telegram WebApp signature verification.
- Only owner can manage moderators.
- Only owner can permanently delete reviewed proofs.
- Pending proofs are never targeted by reviewed-proof deletion.
- Important admin actions are written to `audit_logs`.

## 7. Telegram bot

Owner/moderators can use:
- `/start`
- `/dashboard`
- `/pending`
- `/moderators` (owner)

The bot also provides inline review buttons.

For full proof search, user history, task metadata, signed screenshot preview, bulk operations, moderator controls and a mobile UI, use the web Proof Center.

## 8. Testing checklist

### API
- [ ] `/health` returns `{"status":"ok"}`
- [ ] unauthenticated proof creation is rejected
- [ ] authenticated proof creation stores the screenshot in private Storage
- [ ] proof metadata is saved as JSONB
- [ ] duplicate submission IDs are rejected
- [ ] signed screenshot URLs work temporarily

### Review
- [ ] authorized owner sees pending proofs
- [ ] authorized moderator can approve/reject
- [ ] invalid reviewer cannot access `/api/admin/*`
- [ ] rejected proof requires a predefined reason type
- [ ] custom `reject_reason` remains optional
- [ ] Base44 receives `/api/proof-result`

### Deletion
- [ ] moderator cannot bulk delete
- [ ] owner can delete only approved/rejected proofs
- [ ] pending proofs cannot be deleted through reviewed deletion
- [ ] Storage screenshot is deleted
- [ ] database record is deleted
- [ ] audit log is created

### Reliability
- [ ] restart Render
- [ ] verify records and screenshots remain in Supabase
- [ ] no proof depends on Render filesystem

## Important operational note

For Telegram user submissions, `MAIN_APP_TASK_LOOKUP_PATH` (default `/api/proof-task/:taskId`) is called server-side before a proof is stored. The main app must return the authoritative task identity/details and any reward fields it uses. Reward/credit amounts are never accepted from the browser.

The service cannot independently verify that a screenshot genuinely proves an external action. Reviewers should make that determination using the task requirements and information supplied by the main application.

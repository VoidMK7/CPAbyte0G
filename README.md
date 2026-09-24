# HillsByte Proof Bot + Mini App

A standalone task/proof backend that can run on Render + Supabase without depending on Base44 for task posting or proof review.

## What it does
- Telegram bot + Telegram channel task posting.
- Supabase stores users, tasks, roles, submissions, balances and webhook delivery state.
- Reviewers approve/reject proofs.
- Moderators/admins can post tasks to the Telegram channel.
- Admins can add/remove reviewers and moderators through API.
- Every task has its own reward amount; there is **no fixed/default $0.70 reward**.
- On approval, the backend does **not** credit the user's Base44 balance itself. It sends Base44 the exact task reward as `credit_amount`/`credited`, so Base44 can credit that amount to the correct user.
- Sends `task_submitted`, `task_approved`, and `task_rejected` webhook events to Base44.
- `task_approved` includes the exact task `reward`, plus `credit_amount` and `credited` with the same amount.
- Webhook events are idempotent by `event_id` so retries do not create duplicate Base44 credits if Base44 also uses the event ID as its idempotency key.
- Task posting is independent of Base44. If Base44 goes offline or its integration changes, the task system continues running.

## Render
Build: `npm install`
Start: `npm start`

Set all variables from `.env.example` in Render.

## Supabase
Run `schema.sql` in Supabase SQL Editor, then create a Storage bucket named `proofs` (or change `SUPABASE_BUCKET`). For a private bucket, replace `getPublicUrl` in `server.js` with signed URLs.

## Telegram
Set `BOT_TOKEN`, `CHANNEL_ID`, and `PUBLIC_APP_URL`. The server attempts to set the webhook automatically on startup.
The bot must be allowed to post in the channel.

## Base44 integration
Set:
- `BASE44_WEBHOOK_URL` = the Base44 webhook endpoint that receives events.
- `BASE44_WEBHOOK_SECRET` = shared secret.

Every outbound event has an `X-HillsByte-Signature` HMAC-SHA256 header.

Approval example:
```json
{
  "event":"task_approved",
  "event_id":"task_approved:123",
  "submission_id":123,
  "task_id":45,
  "telegram_id":987654321,
  "reward":0.70,
  "credit_amount":0.70,
  "credited":0.70,
  "status":"approved"
}
```

Rejection includes `reason` and `credited: 0`.

Base44 should treat `event_id` as an idempotency key. When it receives `task_approved`, it should credit `credit_amount` (or `credited`) to the user identified by `telegram_id`. The bot does not perform that Base44 credit itself.

## Security
Reviewer/admin API calls require a valid Telegram Mini App `initData` signed by the bot. Do not expose the Supabase service-role key in frontend code.

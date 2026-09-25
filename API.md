# HillsByte Proof Center API

Base URL: the Render service URL.

All Base44-to-service requests require:

`Authorization: Bearer MAIN_APP_API_SECRET`

All admin web requests require a valid Telegram WebApp `initData` in:

`X-Telegram-Init-Data`

## POST /api/proofs

Creates a pending proof.

Content-Type: `multipart/form-data`

Fields:
- `submission_id` optional unique ID
- `user_telegram_id` required
- `user_name`
- `username`
- `main_app_user_id`
- `task_id` required
- `task_name` required
- `task_description`
- `task_metadata` JSON string
- `submitted_at` optional ISO timestamp
- `screenshot` required image, JPEG/PNG/WebP, max 12 MB

Example task_metadata:

```json
{"subscription_id":"735xxxxxxxx","package":"example","campaign_id":"abc"}
```

Response:

```json
{"proof":{"id":"uuid","submission_id":"...","status":"pending","screenshot_url":"signed-url"}}
```

## GET /api/proofs/:id

For an integration server that has already authenticated with the service. In production, prefer the admin endpoints for review. This project intentionally exposes proof review through `/api/admin/proofs/:id` to keep reviewer data protected.

## GET /api/proofs

Proof listing is intentionally restricted to the admin surface. Use `/api/admin/proofs` with Telegram WebApp authentication.

## POST /api/proofs/:id/approve
## POST /api/proofs/:id/reject
## DELETE /api/proofs/:id
## DELETE /api/proofs/reviewed

These mutation routes are protected under `/api/admin/*` so public callers cannot approve/reject/delete proofs.

## GET /api/users/:telegramId
## GET /api/users/:telegramId/history
## GET /api/tasks/:taskId

The equivalent secure reviewer routes are:
- `GET /api/admin/users/:telegramId`
- `GET /api/admin/users/:telegramId/history`
- `GET /api/admin/tasks/:taskId`

The service retrieves user/activity information from `MAIN_APP_API_URL` with `MAIN_APP_API_SECRET`.

## POST /api/proof-result

This is the callback destination expected on the main application side. The Proof Center also sends approval/rejection results to:

`MAIN_APP_API_URL/api/proof-result`

Example approval:

```json
{
  "submission_id":"sub_123",
  "user_id":"123456789",
  "task_id":"735",
  "status":"approved",
  "reviewed_by":"999999999",
  "reviewed_at":"2026-09-25T12:00:00.000Z"
}
```

Example rejection:

```json
{
  "submission_id":"sub_123",
  "user_id":"123456789",
  "task_id":"735",
  "status":"rejected",
  "reviewed_by":"999999999",
  "reviewed_at":"2026-09-25T12:00:00.000Z",
  "reject_reason_type":"invalid_screenshot",
  "reject_reason":"The task ID is not visible."
}
```

## GET /health

Returns:

```json
{"status":"ok"}
```

## Integration notes

The proof service is the source of truth for proof review status. Base44 remains the user-facing application.

The Base44 app should:
1. authenticate to this service using `MAIN_APP_API_SECRET`;
2. submit proof metadata and the screenshot to `POST /api/proofs`;
3. store the returned `submission_id`;
4. update its own task state when it receives `/api/proof-result`.

Do not place the Supabase service-role key or Telegram bot token in Base44 frontend JavaScript.

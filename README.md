# HillsByte Proof Bot — Clean Render Build

This is the clean replacement for the previous deployment.

## Important repo layout

The GitHub repository root must contain:

server.js
package.json
render.yaml
.env.example
schema.sql
public/index.html

Do NOT put these inside another nested folder.

## Render

Build command:
`npm install`

Start command:
`npm start`

After deployment, the service should respond at:

`/`
A browser page confirming the Proof Bot is online.

`/health`
JSON health information.

`/api/health`
JSON API health information.

The server uses an absolute path for `public/index.html`, so the working directory does not affect static-file routing.

## Environment variables

Set:
- BOT_TOKEN
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- SUPABASE_BUCKET=proofs
- ADMIN_TELEGRAM_IDS
- CHANNEL_ID
- PUBLIC_APP_URL

`PUBLIC_APP_URL` should be the Render URL, for example:
`https://your-service.onrender.com`

APP_URL or Render's RENDER_EXTERNAL_URL can also be used as a fallback.

Base44 variables are optional for this deployment:
- BASE44_WEBHOOK_URL
- BASE44_WEBHOOK_SECRET

## Supabase

Run `schema.sql` in the Supabase SQL editor and create a Storage bucket named `proofs`.

## Telegram

The bot webhook is configured automatically only when BOT_TOKEN and a public app URL are available.

The Telegram Mini App must be opened from Telegram so signed Telegram init data is available for authenticated API calls.

# HillsByte Proof Bot — Fixed v2

This build uses a conventional Node entrypoint and a separate frontend entrypoint.

## Required root structure

server.js
index.js
package.json
render.yaml
schema.sql
.env.example
public/
  index.html
  main.js
  styles.css

Do not put these files inside an extra nested folder.

## Render

Build: `npm install`
Start: `npm start`
Health check: `/health`

The server listens on Render's PORT and serves `public/index.html` from an absolute filesystem path.

## Environment

Set these on Render:
- BOT_TOKEN
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- SUPABASE_BUCKET=proofs
- ADMIN_TELEGRAM_IDS
- CHANNEL_ID
- PUBLIC_APP_URL=https://YOUR-SERVICE.onrender.com

`BASE44_WEBHOOK_URL` and `BASE44_WEBHOOK_SECRET` are optional until Base44 integration is enabled.

## Important

The website can load at `/` without Telegram authentication. User/task/reviewer/admin actions require the page to be opened inside Telegram because the API validates Telegram Web App init data.

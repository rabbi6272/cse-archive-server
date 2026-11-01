# cse-archive-server

Drive service for the RUET CSE Archive site. It lists Google Drive folders, caches them in memory, and clears the cache when Google sends a change notification. It runs on Bun + Hono on Render.

## How it works

```
Browser (drive page)   ──POST /api/drive──────────▶ this server → cache hit? → else Google Drive API
Admin page             ──/api/drive/admin (Bearer)─▶ this server
Google Drive           ──webhook──────────────────▶ /api/drive/webhook → clear the whole cache
cron-job.org (daily)   ──renew-watch (Bearer)─────▶ renew the Google watch if it expires within 24h
cron-job.org (10 min)  ──/health──────────────────▶ keeps the free Render instance awake
```

| Data | Where | Survives restart? |
|---|---|---|
| Folder listings | In-memory `Map`, 12 h TTL (`src/cache.ts`) | No, it's re-fetched on the next request |
| Page token | Firebase RTDB `drive/meta/pageToken` | Yes |
| Watch channel | Firebase RTDB `drive/meta/watch` (`channelId`, `resourceId`, `expiration`) | Yes |
| Last webhook | Firebase RTDB `drive/meta/lastNotification` | Yes |

Any change in Drive clears **all** cached folders. Changes are rare, so it doesn't track which folder changed.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Returns `ok`, for uptime pings |
| `POST /api/drive` | none, CORS-limited to `ALLOWED_ORIGIN` | Body `{ "folderId": "..." }` returns `{ files, parentFolderId, currentFolder }`. A malformed `folderId` gets a 400. |
| `GET /api/drive` | none | Status: RTDB reachable, watch expiry, page token, last webhook |
| `POST /api/drive/webhook` | `x-goog-channel-token` + channel id + resource id | Google push notifications |
| `GET\|POST /api/drive/renew-watch` | `Bearer CRON_SECRET` or `Bearer ADMIN_SECRET` | Daily watch renewal |
| `GET /api/drive/admin` | `Bearer ADMIN_SECRET` | Status snapshot |
| `POST /api/drive/admin` | `Bearer ADMIN_SECRET` | Body `{ "action": ... }`, see below |

Admin actions:

| action | does | extra body |
|---|---|---|
| `setup` | Creates the page token and watch channel if missing or expired | — |
| `revalidate` | Clears the cache, and can pre-fetch the root folder | `"warm": true` |
| `delete` | Clears the cache, and can also wipe `drive/meta/*` | `"clearMeta": true` |
| `renew` | Renews the watch now | — |
| `status` | Status only | — |

## Environment variables

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY` | Drive service account (read-only scope) |
| `FIREBASE_ADMIN_CLIENT_EMAIL`, `FIREBASE_ADMIN_PRIVATE_KEY`, `FIREBASE_ADMIN_PROJECT_ID` | Firebase Admin, for `drive/meta/*` |
| `FIREBASE_ADMIN_DATABASE_URL` | **Regional** RTDB URL, e.g. `https://<project>-default-rtdb.<region>.firebasedatabase.app` |
| `GOOGLE_DRIVE_WEBHOOK_URL` | `https://<app>.onrender.com/api/drive/webhook` |
| `GOOGLE_DRIVE_WEBHOOK_TOKEN` | Random secret that Google echoes back on every webhook |
| `ADMIN_SECRET` | Admin page and admin API |
| `CRON_SECRET` | cron-job.org renew job |
| `ALLOWED_ORIGIN` | The site's origin, e.g. `https://ruet-cse-archive.vercel.app` |
| `PORT` | Set by Render (default 3000) |

Generate secrets with `openssl rand -hex 32`.

## Deploy (Render)

1. New **Web Service** from this repo, **Docker** runtime, health check path `/health`.
2. Set the env vars above.
3. cron-job.org jobs (turn on failure emails):

   | Job | URL | Schedule | Request |
   |---|---|---|---|
   | Keep awake | `https://<app>.onrender.com/health` | every 10 min | GET |
   | Renew watch | `https://<app>.onrender.com/api/drive/renew-watch` | daily 03:00 UTC | GET, header `Authorization: Bearer <CRON_SECRET>` |

4. Create the watch once:
   ```bash
   curl -X POST https://<app>.onrender.com/api/drive/admin \
     -H "Authorization: Bearer <ADMIN_SECRET>" -H "Content-Type: application/json" \
     -d '{"action": "setup"}'
   ```
   **Moving from the old Vercel webhook:** run `{"action":"delete","clearMeta":true}` first, then `setup`, so the new channel points at Render. The old channel just expires.

5. Set `NEXT_PUBLIC_DRIVE_API_URL=https://<app>.onrender.com` on the Vercel site and redeploy it.

## Local development

```bash
bun install
bun test          # cache tests
bun run dev       # http://localhost:3000, restarts on change
```

Put the env vars in `.env` (Bun loads it automatically, and it's gitignored). Google can't reach `localhost`, so for webhooks use a tunnel (`cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`) and set `GOOGLE_DRIVE_WEBHOOK_URL` to the tunnel URL.

## Troubleshooting

- **"No page token, cannot process changes":** run the admin `setup` action.
- **"Invalid token, ignoring":** `GOOGLE_DRIVE_WEBHOOK_TOKEN` doesn't match the token the watch was created with. Re-run `setup` after `delete` + `clearMeta`.
- **"Unknown channel, ignoring":** a notification from an old channel. Harmless, and it stops when that channel expires.
- **Webhook returns 500:** Firebase RTDB is unreachable (check the regional `FIREBASE_ADMIN_DATABASE_URL`) or the Drive API failed (credentials, quota). Check the Render logs.
- **New files don't show up:** check that `lastNotification` in `GET /api/drive` is recent and the watch isn't expired. Force a refresh with `{"action":"revalidate","warm":true}`. The 12 h TTL refreshes the data anyway if webhooks stop.
- **Slow first load:** the instance slept, because the keep-awake cron isn't running. Check cron-job.org.

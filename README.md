# cfworkers-telebot

Cloudflare Worker + Telegram bot that serves a dynamic, hierarchical (multi-level) reply keyboard to users and allows admins to manage buttons, send media, and broadcast messages. It persists user / button state in a Cloudflare KV namespace and serves a small static frontend (from `public/`) that can call the management API.

## Features

- Telegram Bot (long‑polling not required; uses webhook endpoint `/webhook`).
- Dynamic nested menu (top‑level + sub‑buttons) rendered as Telegram reply keyboards.
- Markdown‑like authoring ( **bold**, *italic*, __underline__, ~~strike~~, `code`, [links](https://example.com) ) converted to Telegram HTML format.
- Media attachments per button (photo, document, sticker) + optional caption (HTML formatted).
- Broadcast endpoint to push a message or media to all users who started the bot.
- Admin authentication (simple list of admin chat IDs via env var `ADMIN_IDS`).
- Automatic refresh of all users' keyboards when buttons are added / updated / deleted.
- Basic per‑user data storage commands: `/save`, `/get`, `/update`, `/delete`.
- Commands: `/start`, `/refresh`, `/menu` to show menu.
- Hierarchical navigation with a Back button (⬅️ Back).
- Vitest setup for future unit / worker tests.

## Architecture Overview

```
Cloudflare Worker (src/index.js)
  ├─ Telegram webhook handler  (/webhook)
  ├─ Admin/management API      (/api/...)
  │    ├─ /api/auth           (POST) -> validates admin chatId
  │    ├─ /api/buttons        (GET/POST) -> list/create buttons (top-level or sub)
  │    ├─ /api/buttons/:id    (GET/PUT/DELETE) -> CRUD specific button
  │    └─ /api/broadcast      (POST) -> send broadcast (text + optional media)
  ├─ Static assets            (public/*) served via ASSETS binding
  └─ KV (USER_DATA)           stores buttons + user markers (user_<id>_started, etc.)
```

## Data Model (KV)

- `buttons`: JSON array of button objects recursively shaped as:
  ```json
  {
    "id": "1731957812345",
    "text": "Main",
    "response": "<b>HTML formatted reply</b>",
    "mediaUrl": "https://...",
    "mediaType": "photo|document|sticker",
    "caption": "<i>HTML caption</i>",
    "subButtons": [ /* same shape */ ]
  }
  ```
- `user_<chatId>_started`: presence indicates a user ran /start.
- `user_<chatId>`: arbitrary user saved data (via /save, /update, etc).
- `user_<chatId>_last_keyboard_msg`: JSON with `{ messageId, date }` for menu cleanup.

## API Reference

Base URL: `https://<your-worker-domain>`

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/api/auth` | POST | `{ "chatId": "123" }` | Returns `{ success: true|false }` if chatId is admin. |
| `/api/buttons` | GET | — | Returns full buttons array. |
| `/api/buttons` | POST | `{ text, response, parentId?, mediaUrl?, mediaType?, caption? }` | Create button (top-level if no parentId). Returns created button. |
| `/api/buttons/:id` | GET | — | Get button by id. |
| `/api/buttons/:id` | PUT | `{ text, response }` | Update a button's text/response (media edits could be extended similarly). |
| `/api/buttons/:id` | DELETE | — | Remove button (only top-level in current logic; sub-button removal would need recursion if added). |
| `/api/broadcast` | POST | `{ message?, mediaUrl?, mediaType?, caption? }` | Broadcast to all users who started the bot. |
| `/webhook` | POST | Telegram update payload | Consumed by Telegram (set via BotFather). |

All responses are JSON unless otherwise noted. Authentication (for now) is a simple pre-check using `chatId` against `ADMIN_IDS` list; you should place any admin UI behind a server you control and/or add a token-based layer if exposed publicly.

## Environment / Configuration

Configuration lives in `wrangler.jsonc`.

| Key | Purpose |
|-----|---------|
| `name` | Worker name (used by Wrangler). |
| `main` | Entry script. |
| `kv_namespaces` | Binds `USER_DATA` namespace. |
| `vars.TELEGRAM_BOT_TOKEN` | Bot token (SHOULD be a secret in production!). |
| `vars.ADMIN_IDS` | Comma separated admin chat IDs. |
| `assets.directory` | Static assets folder. |

### Security Note
Do **not** commit real bot tokens. Move `TELEGRAM_BOT_TOKEN` to a secret:
```
wrangler secret put TELEGRAM_BOT_TOKEN
```
Then remove it from `wrangler.jsonc` or override per-environment.

Likewise you can store `ADMIN_IDS` as a secret or environment var in production:
```
wrangler secret put ADMIN_IDS
```

## Local Development

Prerequisites:
- Node.js 18+ (Cloudflare Workers runtime aligns with modern JS runtime features)
- Wrangler CLI (installed via devDependency already)

Install dependencies:
```
npm install
```

Start a local dev session (with live reload):
```
npm run dev
```
Wrangler will print a local tunnel URL (e.g. `http://127.0.0.1:8787`).

### Setting the Telegram Webhook (Local via tunnel)
Use a tunneling solution (e.g. `cloudflared tunnel`, `ngrok`) to expose your local Worker URL publicly, then set the Telegram webhook:
```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<public-hostname>/webhook
```
To inspect:
```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo
```
Remove webhook (fallback to polling, not used here):
```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook
```

### Production Deployment

1. Ensure KV namespace exists (if not already):
   - Create via dashboard or: `wrangler kv namespace create USER_DATA`
   - Copy the `id` into `wrangler.jsonc`.
2. Set secrets (recommended):
   ```
   wrangler secret put TELEGRAM_BOT_TOKEN
   wrangler secret put ADMIN_IDS
   ```
3. Deploy:
   ```
   npm run deploy
   ```
4. Set webhook to production domain:
   ```
   curl https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/setWebhook?url=https://<your-worker-subdomain>/webhook
   ```

## Button Creation Flow

1. Admin UI (or manual API call) POST to `/api/buttons` with `text`, `response` (markdown-like), optional `parentId`, media fields.
2. Worker saves updated buttons JSON to KV.
3. `refreshAllKeyboards` triggers: removes old menu messages and re-sends updated keyboards to every user who previously started the bot.
4. Users press buttons -> Worker looks up button (by text) -> sends media + formatted HTML response, shows sub-menu if exists.

## Formatting Rules
Input (button response / caption) supports:
```
**bold**
*italic*
__underline__
~~strikethrough~~
`inline code`
[link text](https://example.com)
```
They get converted to Telegram HTML tags `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<a href="...">` respectively. Avoid nesting for now (simple regexes).

## Commands for Users
| Command | Action |
|---------|--------|
| `/start` | Registers user (marks KV key) + shows menu. |
| `/refresh` or `/menu` | Re-sends main menu. |
| `/save <data>` | Stores arbitrary string. |
| `/get` | Returns stored data. |
| `/update <data>` | Overwrites stored data. |
| `/delete` | Deletes stored data. |
| `/broadcast <msg>` (admin only) | Broadcasts text message to all started users. |

## Testing
Currently `vitest` is configured. Add tests in `test/` naming with `.spec.js` and run:
```
npm test
```
You can explore `@cloudflare/vitest-pool-workers` for Worker environment simulation.

## Extending / Next Ideas
- Auth: Add a bearer token or session for admin panel instead of raw `chatId` check.
- Rate limiting per user (e.g. Durable Object or KV-based counters).
- Button deletion for nested sub-buttons (recursive removal helper).
- Button reordering (store order index).
- Richer formatting / safe sanitizer.
- Add other media types (audio, video, animation) easily by switching in switch-case.
- Migrate to R2 or D1 for large structured data if KV grows.

## Troubleshooting
| Issue | Tip |
|-------|-----|
| Keyboard not updating | Ensure `refreshAllKeyboards` runs (POST create/update/delete); check Worker logs. |
| HTML not rendering | Verify `parseMode: 'HTML'` and that tags are valid and not overlapping. |
| Broadcast skipped users | Only users who issued `/start` (creating `_started` key) are included. |
| Webhook not firing | Check `getWebhookInfo`; verify HTTPS and that Worker route deployed. |
| Delete message errors | Normal if Telegram already pruned old messages or they are older than allowed window. |

## License
MIT (see `LICENSE`).

---
Made with Cloudflare Workers + Telegram Bot API.

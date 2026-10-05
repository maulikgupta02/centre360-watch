# centre360-watch

Watches https://a856-centre360.nyc.gov/Book for open visit slots and messages Telegram
(@JagaoBot) once per newly opened slot.

## Live: Cloudflare Worker (`worker/`)

A cron trigger checks every minute and alerts every subscriber. The Telegram webhook handles
`/start` (subscribe), `/stop` and `/status` (a live check). Subscribers are kept in KV, and the
owner (`TELEGRAM_CHAT_ID`) always gets alerts.

It stays on the free plan: about 1,440 runs a day, and KV is written only when something changes.
Each run makes at most 50 subrequests, with 20 kept for sending. If more dates are open than the
rest can cover, the extra dates are announced without times. Messages a run can't send wait in a
KV outbox for the next run.

```
cd worker
npx wrangler deploy                          # needs CLOUDFLARE_API_TOKEN or `wrangler login`
printf '%s' "$VALUE" | npx wrangler secret put TELEGRAM_BOT_TOKEN   # also TELEGRAM_CHAT_ID, WEBHOOK_SECRET
npx wrangler dev --test-scheduled            # local; secrets in worker/.dev.vars
```

After changing `WEBHOOK_SECRET`, re-register the webhook:
`curl "https://api.telegram.org/bot<token>/setWebhook" -d url=https://centre360-watch.maulikgupta02.workers.dev/ -d secret_token=<secret>`

## Fallbacks

- `watch.py` (Python 3.9+, stdlib only) is the same checker as a local loop:
  `TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... python3 watch.py`. Its `/start` and `/status` only
  work while the Telegram webhook is deleted (`deleteWebhook`). Env: `POLL_SECONDS` (60),
  `MIN_SEATS` (1).
- `.github/workflows/watch.yml` runs `watch.py` on Actions. It is **disabled**, because GitHub ran
  the 5-minute schedule only every 3–6 hours. A manual run with `min_seats=0` still sends a test alert.

# centre360-watch

Polls https://a856-centre360.nyc.gov/Book for open visit slots and messages you on Telegram.
Python 3.9+ stdlib only.

1. Create a bot with @BotFather and copy its token. Use a new bot, not Jojo's: two processes
   long-polling one token steal each other's updates.
2. `TELEGRAM_BOT_TOKEN=... python3 watch.py`, then send `/start` to the bot. It replies with your chat id.
3. Restart with `TELEGRAM_CHAT_ID=<id>` set as well.

Optional: `POLL_SECONDS` (default 60; drops to 10s on the 1st of the month, 9-11am ET, when new
slots are released), `MIN_SEATS` (default 1). Bot commands: `/status`.

Run in the background: `nohup python3 watch.py > watch.log 2>&1 &`

## GitHub Actions

`.github/workflows/watch.yml` runs every 5 minutes. Each run checks every `POLL_SECONDS` for 270s,
then exits, so coverage is close to continuous. Bot commands don't work in this mode. Get the
chat id by running it locally once.

- Add repo secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- Use a public repo. Actions minutes are free there, and this needs about 8,600 a month, well over
  a private repo's free 2,000.
- GitHub turns scheduled workflows off after 60 days with no repo activity. Re-enable it from the
  Actions tab.

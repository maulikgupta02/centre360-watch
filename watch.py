"""Watches Centre360 (a856-centre360.nyc.gov) for open visit slots and pings Telegram.

Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (optional: send /start to the bot and it replies with
the id), POLL_SECONDS (default 60), MIN_SEATS (default 1).
Bot commands: /start, /status.
RUN_SECONDS: check for that long and exit, with no bot commands (for scheduled CI runs).
"""

from __future__ import annotations

import gzip
import http.cookiejar
import json
import logging
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

SITE = "https://a856-centre360.nyc.gov"
BOOK_URL = f"{SITE}/Book"
NY = ZoneInfo("America/New_York")
STATE_FILE = Path(__file__).with_name("state.json")

BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "60"))
MIN_SEATS = int(os.environ.get("MIN_SEATS", "1"))
RUN_SECONDS = int(os.environ.get("RUN_SECONDS", "0"))

log = logging.getLogger("centre360")
_last_check: dict = {"at": None, "dates": [], "error": None}


class Centre360:
    def __init__(self) -> None:
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )
        self._token: str | None = None

    def _get(self, url: str, headers: dict | None = None) -> tuple[int, bytes]:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0", "Accept-Encoding": "gzip", **(headers or {})},
        )
        try:
            with self._opener.open(req, timeout=30) as resp:
                status, body, enc = resp.status, resp.read(), resp.headers.get("Content-Encoding")
        except urllib.error.HTTPError as e:
            status, body, enc = e.code, e.read(), e.headers.get("Content-Encoding")
        return status, gzip.decompress(body) if enc == "gzip" else body

    def _login(self) -> None:
        # The API wants the session cookie and anti-forgery token that the Book page hands out.
        _, html = self._get(BOOK_URL)
        match = re.search(rb"RequestVerificationToken':\s*'([^']+)'", html)
        if not match:
            raise RuntimeError("anti-forgery token not found on /Book")
        self._token = match.group(1).decode()

    def _api(self, path: str) -> list[dict]:
        for attempt in range(2):
            if self._token is None:
                self._login()
            status, body = self._get(f"{SITE}{path}", {"RequestVerificationToken": self._token})
            if status == 200:
                return json.loads(body)
            if status in (400, 401, 403) and attempt == 0:
                self._token = None
                continue
            raise RuntimeError(f"{path} -> HTTP {status}: {body[:200]!r}")
        raise RuntimeError("unreachable")

    def dates(self) -> list[dict]:
        return self._api("/api/tours/dates")

    def slots(self, date: str) -> list[dict]:
        return self._api(f"/api/tours/available?date={urllib.parse.quote(date)}")


def telegram(method: str, **params) -> dict:
    data = json.dumps(params).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{BOT_TOKEN}/{method}",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=params.get("timeout", 0) + 30) as resp:
        return json.loads(resp.read())


def send(text: str, chat_id: str | None = None) -> None:
    target = chat_id or CHAT_ID
    if not target:
        log.warning("no TELEGRAM_CHAT_ID yet; send /start to the bot. Message was:\n%s", text)
        return
    telegram("sendMessage", chat_id=target, text=text[:4000], disable_web_page_preview=True)


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def poll_interval() -> int:
    # New slots drop on the 1st of each month at 10am ET; check fast around then.
    now = datetime.now(NY)
    if now.day == 1 and 9 <= now.hour < 11:
        return min(POLL_SECONDS, 10)
    return POLL_SECONDS


def check(site: Centre360, notified: dict) -> None:
    dates = site.dates()
    _last_check.update(at=datetime.now(NY), dates=dates, error=None)
    open_dates = [d for d in dates if d["availableSpots"] >= MIN_SEATS]

    still_open: dict = {}
    new_lines = []
    for d in open_dates:
        for slot in site.slots(d["date"]):
            if slot.get("isPast") or slot["availableSpots"] < MIN_SEATS:
                continue
            still_open[slot["id"]] = slot["availableSpots"]
            if slot["id"] not in notified:
                day = datetime.fromisoformat(slot["date"]).strftime("%a %b %-d")
                new_lines.append(
                    f"• {day} {slot['time']}: {slot['availableSpots']}/{slot['maxCapacity']} seats"
                )

    if new_lines:
        send("Centre360 slot open!\n" + "\n".join(new_lines) + f"\n\nBook: {BOOK_URL}")
        log.info("notified %d new slot(s)", len(new_lines))

    # Drop slots that filled up again so a later reopening notifies once more.
    notified.clear()
    notified.update(still_open)
    STATE_FILE.write_text(json.dumps(notified))


def status_text() -> str:
    if _last_check["error"]:
        return f"Last check failed: {_last_check['error']}"
    if _last_check["at"] is None:
        return "No check yet."
    dates = _last_check["dates"]
    open_dates = [d for d in dates if d["availableSpots"] > 0]
    lines = [f"Checked {_last_check['at']:%b %-d %H:%M:%S} ET, {len(dates)} dates listed"]
    if dates:
        lines.append(f"Range: {dates[0]['date']} to {dates[-1]['date']}")
    lines += [f"• {d['date']}: {d['availableSpots']}/{d['totalSpots']} seats" for d in open_dates]
    if not open_dates:
        lines.append("Everything fully booked.")
    return "\n".join(lines)


def bot_loop() -> None:
    offset = None
    while True:
        try:
            resp = telegram("getUpdates", timeout=50, offset=offset)
            for update in resp.get("result", []):
                offset = update["update_id"] + 1
                msg = update.get("message") or {}
                text, chat = msg.get("text", ""), str(msg.get("chat", {}).get("id", ""))
                if text.startswith("/start"):
                    send(f"Watching Centre360. Your chat id: {chat}\nSend /status any time.", chat)
                elif text.startswith("/status"):
                    send(status_text(), chat)
        except Exception:
            log.exception("telegram getUpdates failed")
            time.sleep(10)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    deadline = time.monotonic() + RUN_SECONDS if RUN_SECONDS else None
    if deadline is None:
        threading.Thread(target=bot_loop, daemon=True).start()
        send(f"Centre360 watcher started (every {POLL_SECONDS}s, min {MIN_SEATS} seat(s)).")

    site = Centre360()
    notified = load_state()
    failures = 0
    while True:
        try:
            check(site, notified)
            failures = 0
        except Exception as e:
            failures += 1
            _last_check["error"] = str(e)
            log.exception("check failed")
            if failures == 5:
                send(f"Centre360 watcher: 5 checks in a row failed. Last error: {e}")
        if deadline is not None and time.monotonic() + poll_interval() > deadline:
            if failures:
                raise SystemExit(1)
            return
        time.sleep(poll_interval())


if __name__ == "__main__":
    main()

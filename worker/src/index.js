// Cloudflare Worker port of watch.py: a cron trigger checks every minute, and a Telegram
// webhook answers /start and /status.

const SITE = "https://a856-centre360.nyc.gov";
const BOOK_URL = `${SITE}/Book`;
const UA = "Mozilla/5.0";

async function session() {
  // The API wants the session cookie and anti-forgery token that the Book page hands out.
  const resp = await fetch(BOOK_URL, { headers: { "User-Agent": UA } });
  const html = await resp.text();
  const match = html.match(/RequestVerificationToken':\s*'([^']+)'/);
  if (!match) throw new Error(`anti-forgery token not found on /Book (HTTP ${resp.status})`);
  const cookie = resp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { token: match[1], cookie };
}

async function api(sess, path) {
  const resp = await fetch(`${SITE}${path}`, {
    headers: { "User-Agent": UA, RequestVerificationToken: sess.token, Cookie: sess.cookie },
  });
  if (!resp.ok) throw new Error(`${path} -> HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

async function send(env, text, chatId = env.TELEGRAM_CHAT_ID) {
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
  });
  if (!resp.ok) throw new Error(`telegram sendMessage -> HTTP ${resp.status}`);
}

function fmtDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

async function check(env) {
  const minSeats = Number(env.MIN_SEATS || 1);
  const sess = await session();
  const dates = await api(sess, "/api/tours/dates");

  const stillOpen = {};
  const newLines = [];
  const notified = (await env.STATE.get("notified", "json")) || {};
  const openDates = dates.filter((d) => d.availableSpots >= minSeats);
  // Free Workers get 50 subrequests per run; past 40 open dates, announce by date without times.
  for (const d of openDates.slice(40)) {
    stillOpen[d.date] = d.availableSpots;
    if (!(d.date in notified)) newLines.push(`• ${fmtDay(d.date)}: ${d.availableSpots}/${d.totalSpots} seats`);
  }
  for (const d of openDates.slice(0, 40)) {
    for (const slot of await api(sess, `/api/tours/available?date=${encodeURIComponent(d.date)}`)) {
      if (slot.isPast || slot.availableSpots < minSeats) continue;
      stillOpen[slot.id] = slot.availableSpots;
      if (!(slot.id in notified)) {
        newLines.push(`• ${fmtDay(slot.date)} ${slot.time}: ${slot.availableSpots}/${slot.maxCapacity} seats`);
      }
    }
  }

  if (newLines.length) await send(env, `Centre360 slot open!\n${newLines.join("\n")}\n\nBook: ${BOOK_URL}`);

  // KV allows 1,000 writes a day on the free plan, so only write what changed.
  // Slots that filled up again drop out, so a later reopening notifies once more.
  if (JSON.stringify(Object.keys(stillOpen).sort()) !== JSON.stringify(Object.keys(notified).sort())) {
    await env.STATE.put("notified", JSON.stringify(stillOpen));
  }
  return newLines.length;
}

async function statusText(env) {
  let dates;
  try {
    dates = await api(await session(), "/api/tours/dates");
  } catch (err) {
    return `Check failed: ${err.message}`;
  }
  const open = dates.filter((d) => d.availableSpots > 0);
  const failures = await env.STATE.get("failures");
  const lines = [`Live check: ${dates.length} dates listed`];
  if (dates.length) lines.push(`Range: ${dates[0].date} to ${dates.at(-1).date}`);
  if (failures) lines.push(`Scheduled checks failing: ${failures} in a row`);
  lines.push(...open.map((d) => `• ${d.date}: ${d.availableSpots}/${d.totalSpots} seats`));
  if (!open.length) lines.push("Everything fully booked.");
  return lines.join("\n");
}

export default {
  async scheduled(_event, env) {
    try {
      await check(env);
      if ((await env.STATE.get("failures")) !== null) await env.STATE.delete("failures");
    } catch (err) {
      const failures = Number((await env.STATE.get("failures")) || 0) + 1;
      await env.STATE.put("failures", String(failures));
      if (failures === 5) await send(env, `Centre360 watcher: 5 checks in a row failed. Last error: ${err.message}`);
      console.error(err);
    }
  },

  async fetch(request, env) {
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (request.method !== "POST" || secret !== env.WEBHOOK_SECRET) return new Response("ok");
    const msg = (await request.json()).message || {};
    const text = msg.text || "";
    const chat = String(msg.chat?.id || "");
    if (text.startsWith("/start")) {
      await send(env, `Watching Centre360 every minute. Your chat id: ${chat}\nSend /status any time.`, chat);
    } else if (text.startsWith("/status")) {
      await send(env, await statusText(env), chat);
    }
    return new Response("ok");
  },
};

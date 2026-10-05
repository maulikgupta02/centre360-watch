// Cloudflare Worker port of watch.py: a cron trigger checks every minute and alerts every
// subscriber; a Telegram webhook handles /start (subscribe), /stop and /status.

const SITE = "https://a856-centre360.nyc.gov";
const BOOK_URL = `${SITE}/Book`;
const UA = "Mozilla/5.0";
// Free Workers get 50 subrequests per invocation.
const SUBREQUESTS = 50;
// Keep this many subrequests for sending alerts; past that many open dates, announce by date only.
const SEND_RESERVE = 20;

class Budget {
  constructor(n) {
    this.left = n;
  }

  fetch(url, init) {
    if (this.left <= 0) throw new Error("subrequest budget exhausted");
    this.left -= 1;
    return fetch(url, init);
  }
}

async function session(budget) {
  // The API wants the session cookie and anti-forgery token that the Book page hands out.
  const resp = await budget.fetch(BOOK_URL, { headers: { "User-Agent": UA } });
  const html = await resp.text();
  const match = html.match(/RequestVerificationToken':\s*'([^']+)'/);
  if (!match) throw new Error(`anti-forgery token not found on /Book (HTTP ${resp.status})`);
  const cookie = resp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { budget, token: match[1], cookie };
}

async function api(sess, path) {
  const resp = await sess.budget.fetch(`${SITE}${path}`, {
    headers: { "User-Agent": UA, RequestVerificationToken: sess.token, Cookie: sess.cookie },
  });
  if (!resp.ok) throw new Error(`${path} -> HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

// Returns the HTTP status; 403 means the user blocked the bot.
async function send(env, budget, chatId, text) {
  const resp = await budget.fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
  });
  if (!resp.ok && resp.status !== 403) console.error(`sendMessage to ${chatId} -> HTTP ${resp.status}`);
  return resp.status;
}

async function getJson(env, key, fallback) {
  return (await env.STATE.get(key, "json")) || fallback;
}

async function recipients(env) {
  const subs = await getJson(env, "subscribers", []);
  return [...new Set([String(env.TELEGRAM_CHAT_ID), ...subs])];
}

// Sends as many queued messages as the budget allows and keeps the rest for the next run.
async function deliver(env, budget, outbox) {
  const blocked = new Set();
  while (outbox.length && budget.left > 0) {
    const { chat, text } = outbox[0];
    if ((await send(env, budget, chat, text)) === 403) blocked.add(chat);
    outbox.shift();
  }
  if (blocked.size) {
    const subs = await getJson(env, "subscribers", []);
    await env.STATE.put("subscribers", JSON.stringify(subs.filter((c) => !blocked.has(c))));
  }
}

function fmtDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

async function check(env, budget) {
  const minSeats = Number(env.MIN_SEATS || 1);
  const sess = await session(budget);
  const dates = await api(sess, "/api/tours/dates");

  const stillOpen = {};
  const newLines = [];
  const notified = await getJson(env, "notified", {});
  const openDates = dates.filter((d) => d.availableSpots >= minSeats);
  // Values are dates, so a date already announced one way isn't re-announced the other way
  // when the budget changes how much detail a run can fetch.
  const announcedDates = new Set(Object.values(notified));
  const detailed = Math.max(0, budget.left - SEND_RESERVE);
  for (const d of openDates.slice(detailed)) {
    stillOpen[d.date] = d.date;
    if (!announcedDates.has(d.date)) newLines.push(`• ${fmtDay(d.date)}: ${d.availableSpots}/${d.totalSpots} seats`);
  }
  for (const d of openDates.slice(0, detailed)) {
    for (const slot of await api(sess, `/api/tours/available?date=${encodeURIComponent(d.date)}`)) {
      if (slot.isPast || slot.availableSpots < minSeats) continue;
      stillOpen[slot.id] = d.date;
      if (!(slot.id in notified) && !(d.date in notified)) {
        newLines.push(`• ${fmtDay(slot.date)} ${slot.time}: ${slot.availableSpots}/${slot.maxCapacity} seats`);
      }
    }
  }

  // KV allows 1,000 writes a day on the free plan, so only write what changed.
  // Slots that filled up again drop out, so a later reopening notifies once more.
  if (JSON.stringify(Object.keys(stillOpen).sort()) !== JSON.stringify(Object.keys(notified).sort())) {
    await env.STATE.put("notified", JSON.stringify(stillOpen));
  }
  return newLines.length ? `Centre360 slot open!\n${newLines.join("\n")}\n\nBook: ${BOOK_URL}` : null;
}

async function statusText(env) {
  let dates;
  try {
    dates = await api(await session(new Budget(SUBREQUESTS)), "/api/tours/dates");
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

async function reply(env, chat, text) {
  await send(env, new Budget(1), chat, text);
}

export default {
  async scheduled(_event, env) {
    const budget = new Budget(SUBREQUESTS);
    const outbox = await getJson(env, "outbox", []);
    const queued = outbox.length;
    // Finish the previous alert's fan-out first, keeping enough budget for this run's check.
    if (outbox.length) await deliver(env, new Budget(Math.max(0, budget.left - SEND_RESERVE)), outbox);
    budget.left -= queued - outbox.length;

    try {
      const alert = await check(env, budget);
      if (alert) outbox.push(...(await recipients(env)).map((chat) => ({ chat, text: alert })));
      if ((await env.STATE.get("failures")) !== null) await env.STATE.delete("failures");
    } catch (err) {
      const failures = Number((await env.STATE.get("failures")) || 0) + 1;
      await env.STATE.put("failures", String(failures));
      if (failures === 5) {
        outbox.push({ chat: String(env.TELEGRAM_CHAT_ID), text: `Centre360 watcher: 5 checks in a row failed. Last error: ${err.message}` });
      }
      console.error(err);
    }

    const before = outbox.length;
    await deliver(env, budget, outbox);
    if (queued || before) {
      if (outbox.length) await env.STATE.put("outbox", JSON.stringify(outbox));
      else await env.STATE.delete("outbox");
    }
  },

  async fetch(request, env) {
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (request.method !== "POST" || secret !== env.WEBHOOK_SECRET) return new Response("ok");
    const msg = (await request.json()).message || {};
    const text = msg.text || "";
    const chat = String(msg.chat?.id || "");
    if (!chat) return new Response("ok");

    if (text.startsWith("/start")) {
      const subs = await getJson(env, "subscribers", []);
      if (!subs.includes(chat)) await env.STATE.put("subscribers", JSON.stringify([...subs, chat]));
      await reply(env, chat, "Subscribed. You'll get a message here when a Centre360 visit slot opens (checked every minute).\n/status: live availability\n/stop: unsubscribe");
    } else if (text.startsWith("/stop")) {
      const subs = await getJson(env, "subscribers", []);
      if (subs.includes(chat)) await env.STATE.put("subscribers", JSON.stringify(subs.filter((c) => c !== chat)));
      await reply(env, chat, "Unsubscribed. Send /start to subscribe again.");
    } else if (text.startsWith("/status")) {
      await reply(env, chat, await statusText(env));
    }
    return new Response("ok");
  },
};

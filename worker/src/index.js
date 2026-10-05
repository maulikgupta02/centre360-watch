// Cloudflare Worker port of watch.py: a cron trigger checks every minute, books the first open
// slot for the owner (once, if BOOKING is set) and alerts every subscriber; a Telegram webhook
// handles /start (subscribe), /stop and /status.

let SITE = "https://a856-centre360.nyc.gov";
let BOOK_URL = `${SITE}/Book`;
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

async function api(sess, path, body) {
  const resp = await sess.budget.fetch(`${SITE}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "User-Agent": UA,
      RequestVerificationToken: sess.token,
      Cookie: sess.cookie,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const err = new Error(`${path} -> HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
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
  const openSlots = [];
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
      openSlots.push(slot);
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
  const alert = newLines.length ? `Centre360 slot open!\n${newLines.join("\n")}\n\nBook: ${BOOK_URL}` : null;
  return { sess, alert, openSlots };
}

function slotTime(slot) {
  const [, h, m, ap] = slot.time.match(/(\d+):(\d+)\s*(AM|PM)/i);
  return `${slot.date} ${String((Number(h) % 12) + (ap.toUpperCase() === "PM" ? 12 : 0)).padStart(2, "0")}:${m}`;
}

// Books the earliest open slot for the owner, once. Returns a message for the owner and
// BOOKING.shareWith, or null.
async function autobook(env, sess, openSlots) {
  if (!env.BOOKING || (await env.STATE.get("booked")) !== null) return null;
  const who = JSON.parse(env.BOOKING);
  const people = 1 + (who.guests || []).length;
  const skip = new Set(who.skipDates || []);
  const slot = openSlots.filter((s) => s.availableSpots >= people && !skip.has(s.date)).sort((a, b) => slotTime(a).localeCompare(slotTime(b)))[0];
  if (!slot || sess.budget.left < 2) return null;

  const label = `${fmtDay(slot.date)} ${slot.time}`;
  let hold;
  try {
    hold = await api(sess, "/api/bookings/holds", { tourScheduleId: slot.id, numberOfPeople: people, existingHoldId: null });
  } catch (err) {
    // Someone else got there first; try again on the next opening.
    console.error(err);
    return null;
  }
  try {
    const booking = await api(sess, "/api/bookings", {
      tourScheduleId: slot.id,
      holdId: hold.holdId,
      numberOfPeople: people,
      firstName: who.firstName,
      lastName: who.lastName,
      email: who.email,
      phone: who.phone,
      age: who.age,
      guests: who.guests || [],
    });
    await env.STATE.put("booked", JSON.stringify({ id: booking.id, slot: label, at: new Date().toISOString() }));
    return `Auto-booked ${label} for ${who.firstName} ${who.lastName} (${people} ${people === 1 ? "person" : "people"}).\n\nOpen the email sent to ${who.email} and confirm within 60 minutes, or the booking lapses.\n${SITE}/Confirmation?id=${booking.id}\n\nAuto-booking is now off.`;
  } catch (err) {
    if (err.status >= 400 && err.status < 500 && err.status !== 409) {
      // A rejected booking means our details are wrong; stop instead of retrying every minute.
      await env.STATE.put("booked", JSON.stringify({ error: err.message, at: new Date().toISOString() }));
      return `Auto-booking ${label} was rejected, so auto-booking is now off:\n${err.message}`;
    }
    console.error(err);
    return null;
  }
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
    if (env.SITE) {
      SITE = env.SITE;
      BOOK_URL = `${SITE}/Book`;
    }
    const budget = new Budget(SUBREQUESTS);
    const outbox = await getJson(env, "outbox", []);
    const queued = outbox.length;
    // Finish the previous alert's fan-out first, keeping enough budget for this run's check.
    if (outbox.length) await deliver(env, new Budget(Math.max(0, budget.left - SEND_RESERVE)), outbox);
    budget.left -= queued - outbox.length;

    try {
      const { sess, alert, openSlots } = await check(env, budget);
      const booked = await autobook(env, sess, openSlots);
      if (booked) {
        const shareWith = JSON.parse(env.BOOKING).shareWith || [];
        const chats = [...new Set([String(env.TELEGRAM_CHAT_ID), ...shareWith.map(String)])];
        outbox.unshift(...chats.map((chat) => ({ chat, text: booked })));
      }
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
    } else if (text.startsWith("/autobook") && chat === String(env.TELEGRAM_CHAT_ID)) {
      const rearm = text.trim() === "/autobook on";
      if (rearm) await env.STATE.delete("booked");
      const booked = rearm ? null : await env.STATE.get("booked", "json");
      const who = env.BOOKING ? JSON.parse(env.BOOKING) : null;
      const skips = who?.skipDates?.length ? `, skipping ${who.skipDates.join(", ")}` : "";
      await reply(env, chat, !who ? "Auto-booking isn't configured (no BOOKING secret)."
        : booked?.error ? `Auto-booking is off after a rejected booking:\n${booked.error}\nSend /autobook on to re-arm.`
        : booked ? `Auto-booking is off: already booked ${booked.slot}.\nSend /autobook on to re-arm.`
        : `Auto-booking is armed for ${who.firstName} ${who.lastName} (${1 + (who.guests || []).length} people): the earliest open slot gets booked${skips}.`);
    }
    return new Response("ok");
  },
};

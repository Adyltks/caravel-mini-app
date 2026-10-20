/* Caravel на Cloudflare Workers: раздаёт мини апп, принимает вебхук Telegram-бота,
   отдаёт API каталога, заявок и админки. Данные в D1. */
import { Bot, InlineKeyboard, Keyboard, webhookCallback } from "grammy";
import { makeDb } from "./db.js";
import { appendOrder } from "./sheets.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const money = (n, cur) => Number(n).toLocaleString("ru-RU") + " " + cur;

/** Проверка подписи initData из мини аппа. Возвращает пользователя или null. */
export async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const enc = new TextEncoder();
  const hmac = async (keyBytes, data) => crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(data));
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const sig = [...new Uint8Array(await hmac(secret, check))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (sig !== hash) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}

const isAdmin = (env, user) => !!user && String(env.ADMIN_IDS || "").split(",").map((s) => s.trim()).includes(String(user.id));

function makeBot(env, db, webappUrl) {
  const bot = new Bot(env.BOT_TOKEN);
  bot.command("start", async (ctx) => {
    const st = await db.getSettings();
    await ctx.reply(`Здравствуйте! Это ${st.brand}.\n\nОткройте каталог, выберите услуги и оставьте заявку. Менеджер ответит в этом чате.`, {
      reply_markup: new Keyboard().webApp("Открыть каталог услуг", webappUrl).resized(),
    });
  });
  bot.command("catalog", (ctx) => ctx.reply("Каталог услуг:", { reply_markup: new InlineKeyboard().webApp("Открыть", webappUrl) }));
  bot.command("id", (ctx) => ctx.reply(`ID этого чата: ${ctx.chat.id}\nВаш ID: ${ctx.from.id}`));
  // Ответ менеджера клиенту: reply на заявку в админ-чате уходит клиенту
  bot.on("message:text", async (ctx) => {
    if (String(ctx.chat.id) !== String(env.ADMIN_CHAT_ID)) return;
    const r = ctx.message.reply_to_message;
    const m = r && r.text && r.text.match(/tg_id:(\d+)/);
    if (!m) return;
    const st = await db.getSettings();
    await bot.api.sendMessage(m[1], `Сообщение от менеджера ${st.brand}:\n\n${ctx.message.text}`).catch(() => {});
  });
  return bot;
}

async function handleOrder(env, db, data, user, ctx) {
  const all = await db.listServices();
  const items = (data.services || []).map((id) => all.find((s) => s.id === id)).filter(Boolean);
  if (!items.length) throw new Error("Не выбраны услуги");
  const phone = String(data.phone || "").trim();
  if (!/^\+?[\d\s()-]{10,18}$/.test(phone)) throw new Error("Некорректный телефон");
  const st = await db.getSettings();
  const order = await db.createOrder({
    name: String(data.name || "").trim().slice(0, 100) || [user.first_name, user.last_name].filter(Boolean).join(" ") || "—",
    phone,
    username: user.username ? "@" + user.username : "",
    tg_id: user.id,
    services: items.map((s) => s.title),
    total: items.reduce((a, s) => a + s.price, 0),
    comment: String(data.comment || "").trim().slice(0, 1000),
    niche: String(data.niche || "").trim().slice(0, 100),
    budget: String(data.budget || "").trim().slice(0, 50),
  });
  const text =
    `🆕 Заявка №${order.id}\n\n👤 ${order.name} ${order.username}\n📞 ${order.phone}\n\n` +
    `🧾 Услуги:\n${items.map((s) => `• ${s.title} — от ${money(s.price, st.currency)}`).join("\n")}\n💰 Итого от ${money(order.total, st.currency)}\n` +
    (order.niche ? `🏷 Ниша: ${order.niche}\n` : "") +
    (order.budget ? `💵 Бюджет: ${order.budget}\n` : "") +
    (order.comment ? `\n💬 ${order.comment}\n` : "") +
    `\nОтветьте на это сообщение, чтобы написать клиенту. tg_id:${order.tg_id}`;
  const bot = new Bot(env.BOT_TOKEN);
  const notify = Promise.allSettled([
    env.ADMIN_CHAT_ID ? bot.api.sendMessage(env.ADMIN_CHAT_ID, text) : Promise.resolve(),
    appendOrder(env, order),
  ]).then((r) => r.forEach((x) => x.status === "rejected" && console.error("notify:", x.reason && x.reason.message)));
  ctx.waitUntil(notify);
  return order;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      console.error(e);
      return new Response("Ошибка: " + e.message, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
  },
};

async function handle(request, env, ctx) {
    const url = new URL(request.url);
    const db = makeDb(env.DB);
    const origin = url.origin;

    // Вебхук Telegram: адрес /webhook/<WEBHOOK_SECRET>
    if (request.method === "POST" && url.pathname === `/webhook/${env.WEBHOOK_SECRET}`) {
      return webhookCallback(makeBot(env, db, origin + "/"), "cloudflare-mod")(request);
    }
    // Одноразовая настройка: регистрирует вебхук и кнопку меню у бота
    if (url.pathname === "/setup" && url.searchParams.get("key") === env.WEBHOOK_SECRET && env.WEBHOOK_SECRET) {
      try {
        if (!env.BOT_TOKEN) throw new Error("Не задан секрет BOT_TOKEN");
        const bot = new Bot(env.BOT_TOKEN);
        const me = await bot.api.getMe();
        await bot.api.setWebhook(`${origin}/webhook/${env.WEBHOOK_SECRET}`, { drop_pending_updates: true });
        await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Каталог", web_app: { url: origin + "/" } } });
        await bot.api.setMyCommands([{ command: "start", description: "Открыть каталог услуг" }, { command: "id", description: "Узнать ID чата" }]);
        return new Response(`Вебхук и кнопка меню настроены для бота @${me.username}. Напишите боту /start.`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      } catch (e) {
        return new Response("Ошибка настройки: " + (e.description || e.message), { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
    }

    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method === "GET" && url.pathname === "/api/catalog") {
      return json({ ok: true, settings: await db.getSettings(), services: await db.listServices() });
    }
    if (request.method !== "POST") return json({ ok: false, error: "Not found" }, 404);
    try {
      const data = await request.json().catch(() => { throw new Error("Некорректный JSON"); });
      const user = await verifyInitData(data.initData, env.BOT_TOKEN);
      const path = url.pathname;
      if (path === "/api/me") return json({ ok: true, admin: isAdmin(env, user) });
      if (!user) throw new Error("Откройте приложение из Telegram");
      if (path === "/api/order") return json({ ok: true, id: (await handleOrder(env, db, data, user, ctx)).id });
      if (!isAdmin(env, user)) throw new Error("Нет доступа");
      switch (path) {
        case "/api/admin/services": return json({ ok: true, services: await db.listServices(true) });
        case "/api/admin/services/save": return json({ ok: true, service: await db.saveService(data.service || {}) });
        case "/api/admin/services/delete": await db.deleteService(data.id); return json({ ok: true });
        case "/api/admin/orders": return json({ ok: true, orders: await db.listOrders() });
        case "/api/admin/orders/status": return json({ ok: true, order: await db.setOrderStatus(data.id, data.status) });
        case "/api/admin/settings": return json({ ok: true, settings: data.settings ? await db.saveSettings(data.settings) : await db.getSettings() });
        default: return json({ ok: false, error: "Not found" }, 404);
      }
    } catch (e) {
      return json({ ok: false, error: e.message }, 400);
    }
  }

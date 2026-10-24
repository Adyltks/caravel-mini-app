/* Aduka AI на Cloudflare Workers: раздаёт мини-апп, принимает вебхук Telegram-бота,
   отдаёт API каталога, заявок и админки. Данные в D1. */
import { WorkerEntrypoint } from "cloudflare:workers";
import { Bot, InlineKeyboard, Keyboard, webhookCallback } from "grammy";
import { makeDb } from "./db.js";
import { appendOrder } from "./sheets.js";
import { verifyInitData } from "./telegram-auth.js";
import { chatTurn, chatHistory, telegramSession, noteManagerReply, parseWebPayload } from "./bot/channels.js";
import { createD1Store } from "./bot/store.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const money = (n, cur) => Number(n).toLocaleString("ru-RU") + " " + cur;

export { verifyInitData };

const isAdmin = (env, user) => !!user && String(env.ADMIN_IDS || "").split(",").map((s) => s.trim()).includes(String(user.id));

// Метка из ссылки t.me/AdukaMarketing_bot?start=salon_ad → ниша для приветствия и для бота
const START_NICHES = ["cosmetics", "gifts", "salon", "clothing", "construction", "jewelry"];
const START_GREETINGS = {
  cosmetics: "Расскажите, что продаёте и как сейчас принимаете заказы: через директ или WhatsApp?",
  gifts: "Расскажите, что продаёте: цветы, подарки? Как сейчас принимаете заказы?",
  salon: "Расскажите, какие у вас услуги и как сейчас клиенты записываются?",
};
const TG_LIMIT = 4000; // Telegram режет сообщения длиннее 4096 знаков

const groupSender = (env) => async (text) => {
  if (!env.ADMIN_CHAT_ID) return;
  await new Bot(env.BOT_TOKEN).api.sendMessage(env.ADMIN_CHAT_ID, text.slice(0, TG_LIMIT));
};

/** ИИ-ответ в личке бота. Работает в фоне (waitUntil), чтобы Telegram сразу получил 200. */
async function answerInTelegram(env, db, bot, user, chatId, text) {
  const store = createD1Store(env.DB);
  const session = await telegramSession(store, user, "telegram");
  await store.saveSession(session);
  await bot.api.sendChatAction(chatId, "typing").catch(() => {});
  // Фоновая работа после ответа Telegram живёт около 30 секунд: укладываемся в 25
  const r = await chatTurn({ env, db, session, text, store, sendToGroup: groupSender(env), deadlineMs: 25_000 });
  // muted: менеджер ведёт клиента сам, сообщение уже переслано в группу, бот в личке молчит
  if (r.reply && !r.muted) await bot.api.sendMessage(chatId, r.reply.slice(0, TG_LIMIT), { link_preview_options: { is_disabled: true } }).catch((e) => console.error("Telegram:", e.message));
}

function makeBot(env, db, webappUrl, ctxWorker) {
  const bot = new Bot(env.BOT_TOKEN);
  bot.command("start", async (ctx) => {
    const st = await db.getSettings();
    const tag = String(ctx.match || "").toLowerCase();
    const niche = START_NICHES.find((n) => tag.startsWith(n)) || "";
    if (niche && ctx.chat.type === "private") {
      const store = createD1Store(env.DB);
      const session = await telegramSession(store, ctx.from, "telegram");
      session.context = { ...session.context, niche };
      await store.saveSession(session);
    }
    const ask = START_GREETINGS[niche] || "Расскажите, чем занимается ваш бизнес, и я подскажу, что поможет получать больше заявок.";
    await ctx.reply(`Здравствуйте! Это ${st.brand}. Я помощник и отвечаю в любое время.\n\n${ask}\n\nКаталог услуг и цены — кнопкой ниже.`, {
      reply_markup: new Keyboard().webApp("Открыть каталог услуг", webappUrl).resized(),
    });
  });
  bot.command("catalog", (ctx) => ctx.reply("Каталог услуг:", { reply_markup: new InlineKeyboard().webApp("Открыть", webappUrl) }));
  bot.command("id", (ctx) => ctx.reply(`ID этого чата: ${ctx.chat.id}\nВаш ID: ${ctx.from.id}`));
  bot.on("message:text", async (ctx) => {
    // Ответ менеджера клиенту: reply на заявку в админ-чате уходит клиенту, бот в этом чате замолкает
    if (String(ctx.chat.id) === String(env.ADMIN_CHAT_ID)) {
      const r = ctx.message.reply_to_message;
      // Только ответ на сообщение самого бота, и только последняя метка: служебная строка всегда в конце,
      // а выше могут быть слова клиента (метки в них бот обезвреживает, но берём последнюю на всякий случай)
      const m = r?.from?.is_bot && r.text ? [...r.text.matchAll(/tg_id:(\d+)/g)].pop() : null;
      if (!m) return;
      const st = await db.getSettings();
      await bot.api.sendMessage(m[1], `Сообщение от менеджера ${st.brand}:\n\n${ctx.message.text}`).catch(() => {});
      await noteManagerReply(createD1Store(env.DB), m[1], ctx.message.text).catch((e) => console.error("note:", e.message));
      return;
    }
    // Личка: отвечает ИИ (команды обработаны выше, в группах бот молчит)
    if (ctx.chat.type !== "private" || ctx.message.text.startsWith("/")) return;
    ctxWorker.waitUntil(answerInTelegram(env, db, bot, ctx.from, ctx.chat.id, ctx.message.text)
      .catch((e) => console.error("answerInTelegram:", e.message)));
  });
  return bot;
}

/* Служебная связка для лендинга (service binding, entrypoint "ChatBridge"): снаружи не доступна.
   Лендинг сам проверяет Origin и Turnstile и передаёт сюда только проверенные запросы. */
const webHitsByIp = new Map();
export class ChatBridge extends WorkerEntrypoint {
  async chat(payload) {
    const p = parseWebPayload(payload);
    if (!p || !p.message) return { ok: false, error: "bad_request" };
    const ip = String(payload.ip || "?");
    const now = Date.now();
    const hits = (webHitsByIp.get(ip) || []).filter((t) => now - t < 3600 * 1000);
    if (hits.length >= 60) return { ok: false, error: "rate_limited", reply: "Слишком много сообщений. Попробуйте позже или оставьте номер WhatsApp." };
    hits.push(now);
    webHitsByIp.set(ip, hits);

    const env = this.env;
    const db = makeDb(env.DB);
    const store = createD1Store(env.DB);
    const session = (await store.getSession(p.id)) ?? store.newSession(p.id, { source: "web", context: p.context });
    if (!session.verified && payload.verified !== true) return { ok: false, error: "captcha_required" };
    if (payload.verified === true) session.verified = true;
    if (p.context.lead_sent) session.context = { ...session.context, lead_sent: true };
    await store.saveSession(session);
    return chatTurn({ env, db, session, text: p.message, store, sendToGroup: groupSender(env) });
  }

  async history(payload) {
    const p = parseWebPayload({ ...payload, message: "" });
    if (!p) return { ok: false, error: "bad_request" };
    return { ok: true, messages: await chatHistory(createD1Store(this.env.DB), p.id) };
  }

  /* Резервная копия заявки с формы лендинга: пишем в aduka_orders (видно в мини-аппе: Админ → Заявки).
     Лендинг уже проверил Origin, Turnstile, согласие и номер; здесь — только длины и запись. */
  async saveLead(lead) {
    const s = (v, max) => String(v ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max);
    const phone = s(lead?.phone, 20).replace(/\D/g, "");
    if (!/^\d{11,12}$/.test(phone)) return { ok: false, error: "bad_request" };
    const comment = [
      lead.instagram && `Instagram: ${s(lead.instagram, 120)}`,
      lead.products && `Позиций: ${s(lead.products, 40)}`,
      lead.tariff && `Тариф: ${s(lead.tariff, 20)}`,
      `Форма: ${s(lead.form, 10)}`,
      (lead.utm_source || lead.utm_campaign || lead.utm_content) &&
        `UTM: ${s(lead.utm_source, 100) || "-"} / ${s(lead.utm_campaign, 150) || "-"} / ${s(lead.utm_content, 150) || "-"}`,
      lead.page && `Страница: ${s(lead.page, 300)}`,
      lead.chat_session && `Чат на сайте: ${s(lead.chat_session, 36).slice(0, 8)}`,
    ].filter(Boolean).join("\n");
    const order = await makeDb(this.env.DB).createOrder({
      name: "Заявка с сайта",
      phone: `+${phone}`,
      username: "",
      tg_id: null,
      services: ["Каталог (форма на сайте)"],
      total: 0,
      comment,
      niche: s(lead.niche_name || lead.niche, 100),
      budget: "",
    });
    return { ok: true, id: order.id };
  }
}

/* Заявки из браузера без Telegram: скрытое поле-ловушка для ботов и не больше 5 заявок в 10 минут с одного IP. */
const webHits = new Map();
function checkWebOrder(request, data) {
  if (data.website) throw new Error("Заявка отклонена");
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const now = Date.now();
  const hits = (webHits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (hits.length >= 5) throw new Error("Слишком много заявок, попробуйте позже");
  hits.push(now);
  webHits.set(ip, hits);
  if (!String(data.name || "").trim()) throw new Error("Укажите имя");
}

async function handleOrder(env, db, data, user, ctx) {
  user = user || {};
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
    tg_id: user.id || null,
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
    (order.tg_id
      ? `\nОтветьте на это сообщение, чтобы написать клиенту. tg_id:${order.tg_id}`
      : `\n🌐 Заявка с сайта (не из Telegram): свяжитесь с клиентом по телефону.`);
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
      return webhookCallback(makeBot(env, db, origin + "/", ctx), "cloudflare-mod")(request);
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
      // Чат с ИИ в мини-аппе: только из Telegram (подпись initData), общая история с личкой бота
      if (path === "/api/chat" || path === "/api/chat/history") {
        if (!user) return json({ ok: false, error: "forbidden" }, 403);
        const store = createD1Store(env.DB);
        const session = await telegramSession(store, user, "miniapp");
        await store.saveSession(session);
        if (path === "/api/chat/history") return json({ ok: true, messages: await chatHistory(store, session.id) });
        return json(await chatTurn({ env, db, session, text: String(data.message || ""), store, sendToGroup: groupSender(env) }));
      }
      // Заявка принимается и из Telegram, и по обычной ссылке в браузере
      if (path === "/api/order") {
        if (!user) checkWebOrder(request, data);
        return json({ ok: true, id: (await handleOrder(env, db, data, user, ctx)).id });
      }
      if (!user) throw new Error("Откройте приложение из Telegram");
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

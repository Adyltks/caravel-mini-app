/* Caravel bot: открывает мини апп, принимает заявки, шлёт их менеджеру, пишет в Google Таблицу.
   Плюс HTTP API для мини аппа: каталог, заявки и админка (услуги, заявки, настройки). */
require("dotenv").config();
const http = require("http");
const crypto = require("crypto");
const { Bot, InlineKeyboard, Keyboard } = require("grammy");
const sheets = require("./sheets");
const db = require("./db");

const {
  BOT_TOKEN, ADMIN_CHAT_ID, WEBAPP_URL, PORT = 3000,
  ALLOWED_ORIGIN = "*", ADMIN_IDS = "",
} = process.env;
if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBAPP_URL) {
  console.error("Нужны BOT_TOKEN, ADMIN_CHAT_ID и WEBAPP_URL в .env");
  process.exit(1);
}
const adminIds = new Set(ADMIN_IDS.split(",").map((s) => s.trim()).filter(Boolean));
const isAdmin = (user) => !!user && adminIds.has(String(user.id));

const bot = new Bot(BOT_TOKEN);
const money = (n, cur) => n.toLocaleString("ru-RU") + " " + cur;

bot.command("start", async (ctx) => {
  const st = await db.getSettings();
  await ctx.reply(
    `Здравствуйте! Это ${st.brand}.\n\nОткройте каталог, выберите услуги и оставьте заявку. Менеджер ответит в этом чате.`,
    { reply_markup: new Keyboard().webApp("Открыть каталог услуг", WEBAPP_URL).resized() },
  );
});
bot.command("catalog", (ctx) =>
  ctx.reply("Каталог услуг:", { reply_markup: new InlineKeyboard().webApp("Открыть", WEBAPP_URL) }),
);
bot.command("id", (ctx) => ctx.reply(`ID этого чата: ${ctx.chat.id}\nВаш ID: ${ctx.from.id}`));

// Заявка через Telegram.WebApp.sendData (если мини апп открыт с reply-кнопки и CARAVEL_API пустой)
bot.on("message:web_app_data", async (ctx) => {
  try {
    const data = JSON.parse(ctx.message.web_app_data.data);
    const order = await handleOrder(data, ctx.from);
    await ctx.reply(`Заявка №${order.id} принята. Менеджер свяжется с вами.`);
  } catch (e) {
    console.error(e);
    await ctx.reply("Не удалось принять заявку, напишите нам прямо здесь.");
  }
});

// Ответ менеджера клиенту: reply на заявку в админ-чате → пересылка клиенту
bot.on("message:text", async (ctx) => {
  if (String(ctx.chat.id) !== String(ADMIN_CHAT_ID)) return;
  const r = ctx.message.reply_to_message;
  const m = r && r.text && r.text.match(/tg_id:(\d+)/);
  if (!m) return;
  const st = await db.getSettings();
  await bot.api.sendMessage(m[1], `Сообщение от менеджера ${st.brand}:\n\n${ctx.message.text}`).catch(console.error);
});

/** Проверка подписи initData из мини аппа. Возвращает пользователя или null. */
function verifyInitData(initData) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const sig = crypto.createHmac("sha256", secret).update(check).digest("hex");
  if (sig !== hash) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}

async function handleOrder(data, user) {
  const all = await db.listServices();
  const items = (data.services || []).map((id) => all.find((s) => s.id === id)).filter(Boolean);
  if (!items.length) throw new Error("Не выбраны услуги");
  const phone = String(data.phone || "").trim();
  if (!/^\+?[\d\s()-]{10,18}$/.test(phone)) throw new Error("Некорректный телефон");
  const st = await db.getSettings();
  const order = await db.createOrder({
    name: String(data.name || "").trim() || (user ? [user.first_name, user.last_name].filter(Boolean).join(" ") : "—"),
    phone,
    username: user && user.username ? "@" + user.username : "",
    tg_id: user ? user.id : null,
    services: items.map((s) => s.title),
    total: items.reduce((a, s) => a + s.price, 0),
    comment: String(data.comment || "").trim().slice(0, 1000),
  });
  const text =
    `🆕 Заявка №${order.id}\n\n` +
    `👤 ${order.name} ${order.username || ""}\n` +
    `📞 ${order.phone}\n\n` +
    `🧾 Услуги:\n${items.map((s) => `• ${s.title} — от ${money(s.price, st.currency)}`).join("\n")}\n` +
    `💰 Итого от ${money(order.total, st.currency)}\n` +
    (order.comment ? `\n💬 ${order.comment}\n` : "") +
    (order.tg_id ? `\nОтветьте на это сообщение, чтобы написать клиенту. tg_id:${order.tg_id}` : "");
  await bot.api.sendMessage(ADMIN_CHAT_ID, text).catch((e) => console.error("Telegram:", e.message));
  sheets.append({ ...order, date: order.created_at }).catch((e) => console.error("Sheets:", e.message));
  return order;
}

/* ---------- HTTP API ---------- */
const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 2e5) { reject(new Error("Слишком большой запрос")); req.destroy(); } });
  req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("Некорректный JSON")); } });
});

const routes = {
  "GET /api/catalog": async () => ({ ok: true, settings: await db.getSettings(), services: await db.listServices() }),
  "POST /api/order": async (data) => {
    const user = verifyInitData(data.initData);
    if (!user) throw new Error("Откройте приложение из Telegram");
    const order = await handleOrder(data, user);
    return { ok: true, id: order.id };
  },
  "POST /api/me": async (data) => {
    const user = verifyInitData(data.initData);
    return { ok: true, admin: isAdmin(user) };
  },
  // Админка: все запросы POST с initData, доступ только для ADMIN_IDS
  "POST /api/admin/services": async (d) => ({ ok: true, services: await db.listServices(true) }),
  "POST /api/admin/services/save": async (d) => ({ ok: true, service: await db.saveService(d.service || {}) }),
  "POST /api/admin/services/delete": async (d) => { await db.deleteService(String(d.id)); return { ok: true }; },
  "POST /api/admin/orders": async () => ({ ok: true, orders: await db.listOrders() }),
  "POST /api/admin/orders/status": async (d) => ({ ok: true, order: await db.setOrderStatus(d.id, d.status) }),
  "POST /api/admin/settings": async (d) => ({ ok: true, settings: d.settings ? await db.saveSettings(d.settings) : await db.getSettings() }),
};

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const url = req.url.split("?")[0];
  if (req.method === "GET" && url === "/") return res.end("caravel bot ok");
  const handler = routes[`${req.method} ${url}`];
  if (!handler) return json(res, 404, { ok: false, error: "Not found" });
  try {
    const data = req.method === "POST" ? await readBody(req) : {};
    if (url.startsWith("/api/admin/") && !isAdmin(verifyInitData(data.initData))) throw new Error("Нет доступа");
    json(res, 200, await handler(data));
  } catch (e) {
    json(res, 400, { ok: false, error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`API on :${PORT}, Supabase: ${db.enabled ? "да" : "нет (память)"}, админов: ${adminIds.size}`));
  bot.start({ onStart: () => console.log("Bot started") });
}
module.exports = { verifyInitData, server, routes };

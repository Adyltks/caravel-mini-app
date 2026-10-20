/* Caravel bot: открывает мини апп, принимает заявки, шлёт их менеджеру и пишет в Google Таблицу. */
require("dotenv").config();
const http = require("http");
const crypto = require("crypto");
const { Bot, InlineKeyboard, Keyboard } = require("grammy");
const sheets = require("./sheets");

const {
  BOT_TOKEN, ADMIN_CHAT_ID, WEBAPP_URL, PORT = 3000,
  ALLOWED_ORIGIN = "*",
} = process.env;
if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBAPP_URL) {
  console.error("Нужны BOT_TOKEN, ADMIN_CHAT_ID и WEBAPP_URL в .env");
  process.exit(1);
}

const services = require("../webapp/services.js");
const byId = (id) => services.services.find((s) => s.id === id);
const money = (n) => n.toLocaleString("ru-RU") + " " + services.currency;

const bot = new Bot(BOT_TOKEN);
let counter = 1000;
const orderId = () => String(++counter);

bot.command("start", (ctx) =>
  ctx.reply(
    `Здравствуйте! Это ${services.brand}.\n\nОткройте каталог, выберите услуги и оставьте заявку. Менеджер ответит в этом чате.`,
    {
      reply_markup: new Keyboard().webApp("Открыть каталог услуг", WEBAPP_URL).resized(),
    },
  ),
);
bot.command("catalog", (ctx) =>
  ctx.reply("Каталог услуг:", { reply_markup: new InlineKeyboard().webApp("Открыть", WEBAPP_URL) }),
);
bot.command("id", (ctx) => ctx.reply(`ID этого чата: ${ctx.chat.id}`));

// Заявка через Telegram.WebApp.sendData (если мини апп открыт с reply-кнопки)
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
  await bot.api.sendMessage(m[1], `Сообщение от менеджера ${services.brand}:\n\n${ctx.message.text}`).catch(console.error);
});

/** Проверка подписи initData из мини аппа. */
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
  const items = (data.services || []).map(byId).filter(Boolean);
  if (!items.length) throw new Error("Не выбраны услуги");
  const phone = String(data.phone || "").trim();
  if (!/^\+?[\d\s()-]{10,18}$/.test(phone)) throw new Error("Некорректный телефон");
  const order = {
    id: orderId(),
    date: new Date().toISOString(),
    name: String(data.name || "").trim() || (user ? [user.first_name, user.last_name].filter(Boolean).join(" ") : "—"),
    phone,
    username: user && user.username ? "@" + user.username : "",
    tgId: user ? user.id : "",
    services: items.map((s) => s.title),
    total: items.reduce((a, s) => a + s.price, 0),
    comment: String(data.comment || "").trim(),
  };
  const text =
    `🆕 Заявка №${order.id}\n\n` +
    `👤 ${order.name} ${order.username}\n` +
    `📞 ${order.phone}\n\n` +
    `🧾 Услуги:\n${items.map((s) => `• ${s.title} — от ${money(s.price)}`).join("\n")}\n` +
    `💰 Итого от ${money(order.total)}\n` +
    (order.comment ? `\n💬 ${order.comment}\n` : "") +
    (order.tgId ? `\nОтветьте на это сообщение, чтобы написать клиенту. tg_id:${order.tgId}` : "");
  await bot.api.sendMessage(ADMIN_CHAT_ID, text);
  sheets.append(order).catch((e) => console.error("Sheets:", e.message));
  return order;
}

// HTTP API для мини аппа (fetch из браузера Telegram)
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method === "GET" && req.url === "/") return res.end("caravel bot ok");
  if (req.method !== "POST" || req.url !== "/api/order") return res.writeHead(404).end();
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on("end", async () => {
    try {
      const data = JSON.parse(body || "{}");
      const user = verifyInitData(data.initData);
      if (!user) throw new Error("Откройте приложение из Telegram");
      const order = await handleOrder(data, user);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, id: order.id }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
});

server.listen(PORT, () => console.log("API on :" + PORT));
bot.start({ onStart: () => console.log("Bot started") });
module.exports = { verifyInitData };

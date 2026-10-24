/* Каналы ИИ-бота: личные сообщения Telegram, чат в мини-аппе (/api/chat) и чат лендинга (через служебную связку).
   Заявки бота пишутся в aduka_orders и уходят в группу менеджеров (ADMIN_CHAT_ID). */
import Anthropic from "@anthropic-ai/sdk";
import { botReply, TEXTS } from "./brain.js";
import { createD1Store, visibleTranscript } from "./store.js";

export const MUTE_HOURS = 6; // сколько бот молчит в чате после ответа менеджера
const MAX_MESSAGE = 1000;
const SESSION_LIMIT_PER_HOUR = 30;
const SESSION_LIMIT_PER_DAY = 100;
const WEB_LIMIT_PER_HOUR = 300; // все анонимные посетители сайта вместе: защита дневного бюджета
const LOCK_WAIT_MS = 12_000; // вторая реплика ждёт, пока бот ответит на первую
const LOCK_POLL_MS = 1500;

const NICHES = { cosmetics: "Косметика и парфюмерия", gifts: "Цветы и подарки", salon: "Салон красоты", clothing: "Одежда",
  construction: "Стройка", jewelry: "Ювелирные изделия", other: "Другое" };
const QUIZ_PRODUCTS = ["До 30", "До 100", "Больше 100", "Пока не считали"];
const PAGE_HOST = /(^|\.)adyltks\.workers\.dev$|(^|\.)aduka\.ai$/;
const TARIFFS = { start: "Старт", magazin: "Магазин", pro: "Про", other: "другое", unknown: "не обсуждали" };
const TEMPERATURE = { warm: "тёплый", hot: "горячий 🔥" };
const HANDOFF_REASONS = { not_in_knowledge: "нет ответа в базе", custom_request: "нестандартный запрос", complaint: "жалоба",
  wants_human: "просит живого человека", price_talk: "торг или скидка", other: "другое" };

export function makeClient(env) {
  if (!env.ANTHROPIC_API_KEY) return null;
  // Срок каждого запроса задаёт botReply (общий срок на реплику); одна повторная попытка при перегрузке
  return new Anthropic({ apiKey: String(env.ANTHROPIC_API_KEY).trim(), maxRetries: 1, timeout: 25_000 });
}

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim().slice(0, max);
const isMuted = (s, now = new Date()) => !!s.muted_until && new Date(s.muted_until) > now;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Текст посетителя для группы менеджеров: без кликабельных ссылок (защита от фишинга) и без служебной метки
    tg_id (иначе ответ менеджера можно перенаправить тому, чей номер вписал посетитель). */
export function safe(v, max = 400) {
  return clean(v, max)
    .replace(/tg_id\s*:/gi, "tg id ")
    .replace(/\bhttps?:\/\//gi, (m) => m.replace(/t/gi, "x"))
    .replace(/\bwww\./gi, "www[.]")
    .replace(/\b([a-z0-9-]+)\.(com|ru|kg|kz|net|org|me|io|ly|link|site|online|xyz|app|dev)\b/gi, "$1[.]$2");
}

function sourceLine(session) {
  if (session.source === "web") {
    const u = session.context?.utm ?? {};
    const utm = [u.source, u.campaign, u.content].some(Boolean)
      ? `\nUTM: ${safe(u.source, 100) || "-"} / ${safe(u.campaign, 150) || "-"} / ${safe(u.content, 150) || "-"}` : "";
    // Номер чата совпадает с номером в заявке с формы — так их можно сопоставить
    return `Источник: чат на сайте, чат ${session.id.slice(4, 12)}${session.context?.page ? `\nСтраница: ${session.context.page}` : ""}${utm}`;
  }
  const who = session.context?.username ? ` @${session.context.username}` : "";
  return `Источник: ${session.source === "miniapp" ? "чат в мини-аппе" : "личка бота"}${who}`;
}

// Служебная строка с tg_id всегда последняя: index.js берёт последнее совпадение
const replyHint = (session) => session.tg_id
  ? `\nОтветьте на это сообщение, чтобы написать клиенту в Telegram. tg_id:${session.tg_id}`
  : "";

const field = (label, v, max = 400) => (String(v ?? "").trim() ? `${label}: ${safe(v, max)}` : null);

export function leadCard(input, session, id) {
  return [
    `🤖 Заявка из чата №${id} · ${TEMPERATURE[input.temperature] ?? "тёплый"}`,
    "",
    field("Имя", input.name, 100),
    field(`Контакт (${input.contact_type})`, input.contact, 100),
    field("Ниша", input.niche || NICHES[session.context?.niche]),
    field("Как принимает заказы сейчас", input.current_channel),
    field("Боль", input.pain),
    field("Позиций", input.positions, 100),
    field("Срок/повод", input.deadline),
    field("Тариф", TARIFFS[input.tariff]),
    field("Возражения", input.objections),
    field("Созвон/встреча", input.meeting),
    "",
    field("Итог", input.summary, 800),
    sourceLine(session),
  ].filter((x) => x !== null).join("\n") + replyHint(session);
}

/** Побочные эффекты инструментов: запись заявки в базу и сообщения в группу менеджеров. */
export function makeActions(env, db, sendToGroup) {
  return {
    async createLead(input, session) {
      const order = await db.createOrder({
        name: clean(input.name, 100) || "—",
        phone: clean(input.contact, 60) || (session.context?.username ? "@" + session.context.username : "—"),
        username: session.context?.username ? "@" + session.context.username : "",
        tg_id: session.tg_id ?? null,
        services: [`Каталог/услуги: ${TARIFFS[input.tariff] ?? "не обсуждали"}`],
        total: 0,
        comment: safe([input.summary, input.pain && `Боль: ${input.pain}`, input.meeting && `Созвон: ${input.meeting}`]
          .filter(Boolean).join(" | "), 1000),
        niche: clean(input.niche || NICHES[session.context?.niche] || "", 100),
        budget: "",
      });
      await sendToGroup(leadCard(input, session, order.id));
      return { id: order.id };
    },
    async updateLead(input, session) {
      await sendToGroup([
        `📝 Дополнение к заявке №${session.lead_id}`,
        "",
        field("Имя", input.name, 100),
        field(`Контакт (${input.contact_type})`, input.contact, 100),
        field("Созвон/встреча", input.meeting),
        field("Возражения", input.objections),
        field("Итог", input.summary, 800),
      ].filter((x) => x !== null).join("\n") + replyHint(session));
    },
    async handoff(input, session) {
      await sendToGroup([
        `🙋 Бот зовёт менеджера: ${HANDOFF_REASONS[input.reason] ?? "другое"}`,
        "",
        field("Вопрос", input.question, 800),
        field("Контакт", input.contact, 100),
        sourceLine(session),
      ].filter(Boolean).join("\n") + replyHint(session));
    },
  };
}

/** Общий путь одной реплики: лимиты → замок на сессию → бот → ответ. Возвращает ответ для API (ok/reply/lead).
    deadlineMs — сколько всего есть времени (в Telegram фон живёт около 30 секунд). */
export async function chatTurn({ env, db, session, text, sendToGroup, store = createD1Store(env.DB), client = makeClient(env),
  now = new Date(), deadlineMs = 35_000 }) {
  const started = Date.now();
  text = clean(text, MAX_MESSAGE);
  if (!text) return { ok: false, error: "bad_request" };
  if (isMuted(session, now)) {
    // Менеджер ведёт клиента сам: пересылаем сообщение в группу, бот молчит
    const who = session.context?.username ? ` (@${session.context.username})` : "";
    await sendToGroup(`💬 Клиент пишет${who}:\n\n${safe(text, MAX_MESSAGE)}${replyHint(session)}`).catch((e) => console.error("forward:", e.message));
    return { ok: true, reply: "Передал менеджеру, он ответит вам в личных сообщениях этого бота.", lead: false, muted: true };
  }
  if (!client) return { ok: false, error: "unavailable", reply: TEXTS.failed };
  const tooMany = { ok: false, error: "rate_limited", reply: "Слишком много сообщений подряд. Подождите немного или оставьте номер WhatsApp." };
  if ((await store.countUserMessages(session.id, 60)) >= SESSION_LIMIT_PER_HOUR) return tooMany;
  if ((await store.countUserMessages(session.id, 24 * 60)) >= SESSION_LIMIT_PER_DAY) return tooMany;
  if (session.source === "web" && (await store.countWebMessages()) >= WEB_LIMIT_PER_HOUR) {
    return { ok: false, error: "rate_limited", reply: TEXTS.overloaded };
  }

  // Одна реплика за раз: вторая ждёт, пока бот ответит на первую (иначе две заявки и спор за историю)
  let locked = await store.lock(session.id);
  while (!locked && Date.now() - started < LOCK_WAIT_MS) {
    await sleep(LOCK_POLL_MS);
    locked = await store.lock(session.id);
  }
  if (!locked) return { ok: false, error: "busy", reply: "Секунду, отвечаю на предыдущее сообщение." };

  try {
    // Свежая копия сессии: пока ждали, могла появиться заявка или заметка менеджера
    const fresh = (await store.getSession(session.id)) ?? session;
    if (isMuted(fresh)) return { ok: true, reply: "Передал менеджеру, он ответит вам в личных сообщениях этого бота.", lead: false, muted: true };
    const [services, settings] = await Promise.all([db.listServices(), db.getSettings()]);
    const r = await botReply({ client, env, store, session: fresh, text, now, services, settings,
      actions: makeActions(env, db, sendToGroup), deadlineMs: Math.max(8000, deadlineMs - (Date.now() - started)) });
    if (Math.random() < 0.02) await store.cleanup().catch(() => {});
    return { ok: true, reply: r.reply, lead: r.lead };
  } catch (e) {
    console.error("Бот не ответил:", e?.status ?? "", e?.message);
    return { ok: false, error: "unavailable", reply: TEXTS.failed };
  } finally {
    await store.unlock(session.id).catch(() => {});
  }
}

/** Сессия Telegram-пользователя (общая для лички бота и мини-аппа). */
export async function telegramSession(store, user, source) {
  const id = `tg:${user.id}`;
  const s = (await store.getSession(id)) ?? store.newSession(id, { source, tg_id: user.id });
  s.source = source;
  s.tg_id = user.id;
  const username = /^[A-Za-z0-9_]{1,32}$/.test(user.username || "") ? user.username : "";
  s.context = { ...s.context, username: username || s.context?.username || "" };
  return s;
}

/** Менеджер ответил клиенту из группы: бот замолкает и запоминает, что написал менеджер. */
export async function noteManagerReply(store, tgId, text, now = new Date()) {
  const id = `tg:${tgId}`;
  if (!(await store.getSession(id))) return;
  const until = new Date(now.getTime() + MUTE_HOURS * 3600 * 1000).toISOString();
  await store.muteWithNote(id, until, `Менеджер написал клиенту: «${clean(text, 500)}». Не противоречь ему.`);
}

/** История для окна чата. */
export async function chatHistory(store, sessionId) {
  return visibleTranscript(await store.getMessages(sessionId)).slice(-30);
}

/** Страница входа: только наши адреса (её видит менеджер в карточке). */
function cleanPage(v) {
  try {
    const u = new URL(String(v ?? ""));
    return u.protocol === "https:" && PAGE_HOST.test(u.hostname) ? u.href.slice(0, 300) : "";
  } catch {
    return "";
  }
}

/** Проверка входящего с лендинга: id сессии, текст, контекст. Свободный текст из квиза не берём:
    в разговор попадают только значения из известных списков. */
export function parseWebPayload(p) {
  const session = String(p?.session ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session)) return null;
  const message = clean(p.message, MAX_MESSAGE);
  const c = p.context && typeof p.context === "object" ? p.context : {};
  const utm = c.utm && typeof c.utm === "object" ? c.utm : {};
  const q = c.quiz && typeof c.quiz === "object" ? c.quiz : {};
  const quiz = {};
  if (QUIZ_PRODUCTS.includes(q.products)) quiz["сколько позиций"] = q.products;
  if (Object.hasOwn(NICHES, q.niche)) quiz["ниша"] = NICHES[q.niche];
  return {
    id: `web:${session.toLowerCase()}`,
    message,
    context: {
      niche: Object.hasOwn(NICHES, c.niche) ? c.niche : "",
      page: cleanPage(c.page),
      utm: { source: clean(utm.source, 100), campaign: clean(utm.campaign, 150), content: clean(utm.content, 150) },
      ...(Object.keys(quiz).length ? { quiz } : {}),
      ...(c.lead_sent === true ? { lead_sent: true } : {}),
    },
  };
}

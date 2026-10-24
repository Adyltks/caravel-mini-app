/* Каналы ИИ-бота: личные сообщения Telegram, чат в мини-аппе (/api/chat) и чат лендинга (через служебную связку).
   Заявки бота пишутся в aduka_orders и уходят в группу менеджеров (ADMIN_CHAT_ID). */
import Anthropic from "@anthropic-ai/sdk";
import { botReply, TEXTS } from "./brain.js";
import { createD1Store, visibleTranscript } from "./store.js";

export const MUTE_HOURS = 6; // сколько бот молчит в чате после ответа менеджера
const MAX_MESSAGE = 1000;
const SESSION_LIMIT_PER_HOUR = 30;

const NICHES = { cosmetics: "Косметика и парфюмерия", gifts: "Цветы и подарки", salon: "Салон красоты", clothing: "Одежда",
  construction: "Стройка", jewelry: "Ювелирные изделия", other: "Другое" };
const TARIFFS = { start: "Старт", magazin: "Магазин", pro: "Про", other: "другое", unknown: "не обсуждали" };
const TEMPERATURE = { warm: "тёплый", hot: "горячий 🔥" };
const HANDOFF_REASONS = { not_in_knowledge: "нет ответа в базе", custom_request: "нестандартный запрос", complaint: "жалоба",
  wants_human: "просит живого человека", price_talk: "торг или скидка", other: "другое" };

export function makeClient(env) {
  if (!env.ANTHROPIC_API_KEY) return null;
  // timeout меньше лимита фоновой работы Worker (30 с), одна повторная попытка
  return new Anthropic({ apiKey: String(env.ANTHROPIC_API_KEY).trim(), maxRetries: 1, timeout: 25_000 });
}

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim().slice(0, max);
const isMuted = (s, now = new Date()) => !!s.muted_until && new Date(s.muted_until) > now;

function sourceLine(session) {
  if (session.source === "web") {
    const u = session.context?.utm ?? {};
    const utm = [u.source, u.campaign, u.content].some(Boolean) ? `\nUTM: ${u.source || "-"} / ${u.campaign || "-"} / ${u.content || "-"}` : "";
    return `Источник: чат на сайте${session.context?.page ? `\nСтраница: ${session.context.page}` : ""}${utm}`;
  }
  const who = session.context?.username ? ` @${session.context.username}` : "";
  return `Источник: ${session.source === "miniapp" ? "чат в мини-аппе" : "личка бота"}${who}`;
}

const replyHint = (session) => session.tg_id
  ? `\nОтветьте на это сообщение, чтобы написать клиенту в Telegram. tg_id:${session.tg_id}`
  : "";

export function leadCard(input, session, id) {
  const f = (label, v) => (String(v ?? "").trim() ? `${label}: ${String(v).trim()}` : null);
  return [
    `🤖 Заявка из чата №${id} · ${TEMPERATURE[input.temperature] ?? input.temperature}`,
    "",
    f("Имя", input.name),
    f(`Контакт (${input.contact_type})`, input.contact),
    f("Ниша", input.niche || NICHES[session.context?.niche]),
    f("Как принимает заказы сейчас", input.current_channel),
    f("Боль", input.pain),
    f("Позиций", input.positions),
    f("Срок/повод", input.deadline),
    f("Тариф", TARIFFS[input.tariff]),
    f("Возражения", input.objections),
    f("Созвон/встреча", input.meeting),
    "",
    f("Итог", input.summary),
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
        comment: clean([input.summary, input.pain && `Боль: ${input.pain}`, input.meeting && `Созвон: ${input.meeting}`]
          .filter(Boolean).join("\n"), 1000),
        niche: clean(input.niche || NICHES[session.context?.niche] || "", 100),
        budget: "",
      });
      await sendToGroup(leadCard(input, session, order.id));
      return { id: order.id };
    },
    async handoff(input, session) {
      await sendToGroup([
        `🙋 Бот зовёт менеджера: ${HANDOFF_REASONS[input.reason] ?? input.reason}`,
        "",
        `Вопрос: ${clean(input.question, 800)}`,
        input.contact ? `Контакт: ${clean(input.contact, 100)}` : null,
        sourceLine(session),
      ].filter(Boolean).join("\n") + replyHint(session));
    },
  };
}

/** Общий путь одной реплики: лимиты → бот → ответ. Возвращает ответ для API (ok/reply/lead). */
export async function chatTurn({ env, db, session, text, sendToGroup, store = createD1Store(env.DB), client = makeClient(env), now = new Date() }) {
  text = clean(text, MAX_MESSAGE);
  if (!text) return { ok: false, error: "bad_request" };
  if (isMuted(session, now)) {
    // Менеджер ведёт клиента сам: пересылаем сообщение в группу, бот молчит
    const who = session.context?.username ? ` (@${session.context.username})` : "";
    await sendToGroup(`💬 Клиент пишет${who}:\n\n${text}${replyHint(session)}`).catch((e) => console.error("forward:", e.message));
    return { ok: true, reply: "Передал менеджеру, он ответит вам здесь.", lead: false, muted: true };
  }
  if (!client) return { ok: false, error: "unavailable", reply: TEXTS.failed };
  if ((await store.countUserMessages(session.id, 60)) >= SESSION_LIMIT_PER_HOUR) {
    return { ok: false, error: "rate_limited", reply: "Слишком много сообщений подряд. Подождите немного или оставьте номер WhatsApp." };
  }
  const [services, settings] = await Promise.all([db.listServices(), db.getSettings()]);
  try {
    const r = await botReply({ client, env, store, session, text, now, services, settings,
      actions: makeActions(env, db, sendToGroup) });
    if (Math.random() < 0.02) await store.cleanup().catch(() => {});
    return { ok: true, reply: r.reply, lead: r.lead };
  } catch (e) {
    console.error("Бот не ответил:", e?.status ?? "", e?.message);
    return { ok: false, error: "unavailable", reply: TEXTS.failed };
  }
}

/** Сессия Telegram-пользователя (общая для лички бота и мини-аппа). */
export async function telegramSession(store, user, source) {
  const id = `tg:${user.id}`;
  const s = (await store.getSession(id)) ?? store.newSession(id, { source, tg_id: user.id });
  s.source = source;
  s.tg_id = user.id;
  s.context = { ...s.context, username: user.username || s.context?.username || "" };
  return s;
}

/** Менеджер ответил клиенту из группы: бот замолкает и запоминает, что написал менеджер. */
export async function noteManagerReply(store, tgId, text, now = new Date()) {
  const s = await store.getSession(`tg:${tgId}`);
  if (!s) return;
  s.muted_until = new Date(now.getTime() + MUTE_HOURS * 3600 * 1000).toISOString();
  s.note = `${s.note ? s.note + "\n" : ""}Менеджер написал клиенту: «${clean(text, 500)}». Не противоречь ему.`;
  await store.saveSession(s);
}

/** История для окна чата. */
export async function chatHistory(store, sessionId) {
  return visibleTranscript(await store.getMessages(sessionId)).slice(-30);
}

/** Проверка входящего с лендинга: id сессии, текст, контекст. */
export function parseWebPayload(p) {
  const session = String(p?.session ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(session)) return null;
  const message = clean(p.message, MAX_MESSAGE);
  const c = p.context && typeof p.context === "object" ? p.context : {};
  const utm = c.utm && typeof c.utm === "object" ? c.utm : {};
  const quiz = c.quiz && typeof c.quiz === "object"
    ? Object.fromEntries(Object.entries(c.quiz).slice(0, 6).map(([k, v]) => [clean(k, 30), clean(v, 100)])) : undefined;
  return {
    id: `web:${session.toLowerCase()}`,
    message,
    context: {
      niche: Object.hasOwn(NICHES, c.niche) ? c.niche : "",
      page: clean(c.page, 300),
      utm: { source: clean(utm.source, 100), campaign: clean(utm.campaign, 150), content: clean(utm.content, 150) },
      ...(quiz ? { quiz } : {}),
      ...(c.lead_sent === true ? { lead_sent: true } : {}),
    },
  };
}

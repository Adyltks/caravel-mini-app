/* Тесты ИИ-бота без сети: Claude и Telegram подменены заготовками. Запуск: npm test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { botReply, buildSystem, turnNote, TEXTS } from "./src/bot/brain.js";
import { costOf, pickModel, bishkekDay } from "./src/bot/pricing.js";
import { createMemoryStore, trimHistory, visibleTranscript } from "./src/bot/store.js";
import { chatTurn, leadCard, parseWebPayload, noteManagerReply, telegramSession } from "./src/bot/channels.js";

const DAY_14 = new Date("2026-10-24T08:00:00Z"); // 14:00 в Бишкеке
const NIGHT_2330 = new Date("2026-10-24T17:30:00Z"); // 23:30 в Бишкеке

const usage = (input = 100, output = 50) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, iterations: null });
const textResp = (text) => ({ content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }], stop_reason: "end_turn", model: "claude-opus-5-5", usage: usage() });
const toolResp = (name, input, id = "tu_1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use", model: "claude-opus-5-5", usage: usage() });

function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (params) => { calls.push(structuredClone(params)); const r = responses.shift(); if (!r) throw new Error("нет заготовки"); return r; } } },
  };
}
function fakeActions() {
  const log = [];
  return { log, createLead: async (input) => { log.push(["lead", input]); return { id: 1001 }; }, handoff: async (input) => { log.push(["handoff", input]); } };
}
const LEAD = { name: "Айгерим", contact: "+996555000001", contact_type: "whatsapp", niche: "салон", current_channel: "директ", pain: "не успевает отвечать",
  positions: "до 30", deadline: "", tariff: "start", objections: "", meeting: "созвон завтра в 11", temperature: "hot", summary: "Хочет прайс с записью" };

test("обычный ответ: Opus, запрос по правилам API, история только дописывается", async () => {
  const store = createMemoryStore();
  const session = store.newSession("web:1", { source: "web", context: { niche: "salon" } });
  const client = fakeClient([textResp("Как сейчас клиенты записываются?")]);
  const r = await botReply({ client, store, session, text: "Здравствуйте", actions: fakeActions(), now: DAY_14 });
  assert.equal(r.reply, "Как сейчас клиенты записываются?");
  assert.equal(r.model, "claude-opus-5-5");
  const p = client.calls[0];
  assert.equal(p.model, "claude-opus-5-5");
  assert.ok(p.betas.includes("server-side-fallback-2026-07-01") && p.betas.includes("thinking-binding-controls-2026-08-01"));
  assert.equal(p.fallbacks, "default");
  assert.deepEqual(p.thinking, { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
  assert.equal(p.output_config.effort, "low");
  assert.equal(p.tool_choice, undefined, "принудительный выбор инструмента на Opus 5.5 даёт 400");
  assert.equal(p.system[0].cache_control.type, "ephemeral");
  assert.ok(p.tools.every((t) => t.strict === true));
  // Служебное сообщение сразу после реплики посетителя и последним в запросе
  assert.deepEqual(p.messages.map((m) => m.role), ["user", "system"]);
  assert.match(p.messages[1].content, /14:00, рабочее время/);
  assert.match(p.messages[1].content, /Ниша со страницы входа: salon/);
  const saved = store.messages.get("web:1");
  assert.deepEqual(saved.map((m) => m.role), ["user", "system", "assistant"]);
  assert.equal(saved[2].content[0].type, "thinking", "блоки рассуждений сохраняются без изменений");
  assert.ok(await store.getSpend(bishkekDay(DAY_14)) > 0);

  // Вторая реплика: прежняя история идёт в запросе байт в байт
  const client2 = fakeClient([textResp("Понял")]);
  await botReply({ client: client2, store, session, text: "Через директ", actions: fakeActions(), now: DAY_14 });
  assert.deepEqual(client2.calls[0].messages.slice(0, 3), saved);
  assert.doesNotMatch(client2.calls[0].messages[4].content, /Канал:/, "контекст входа только в первой реплике");
});

test("заявка: create_lead → результат инструмента → текст; повторно не создаётся", async () => {
  const store = createMemoryStore();
  const session = store.newSession("tg:42", { source: "telegram", tg_id: 42 });
  const actions = fakeActions();
  const client = fakeClient([toolResp("create_lead", LEAD), textResp("Спасибо! Менеджер свяжется с вами.")]);
  const r = await botReply({ client, store, session, text: "+996555000001, Айгерим", actions, now: DAY_14 });
  assert.equal(r.lead, true);
  assert.equal(r.reply, "Спасибо! Менеджер свяжется с вами.");
  assert.equal(actions.log.length, 1);
  assert.equal(session.lead_id, 1001);
  const second = client.calls[1].messages;
  const last = second[second.length - 1];
  assert.equal(last.role, "user");
  assert.equal(last.content[0].type, "tool_result");
  assert.equal(last.content[0].tool_use_id, "tu_1");

  const client2 = fakeClient([toolResp("create_lead", LEAD, "tu_2"), textResp("Заявка уже у менеджера.")]);
  const r2 = await botReply({ client: client2, store, session, text: "ещё раз", actions, now: DAY_14 });
  assert.equal(actions.log.length, 1, "вторая заявка не создаётся");
  assert.equal(r2.lead, false);
  assert.match(client2.calls[1].messages.at(-1).content[0].content, /уже создана/);
});

test("дневной лимит: после $3 — Sonnet, после аварийного потолка — без запроса к API", async () => {
  assert.equal(pickModel(0), "claude-opus-5-5");
  assert.equal(pickModel(2.99), "claude-opus-5-5");
  assert.equal(pickModel(3), "claude-sonnet-5-5");
  assert.equal(pickModel(5.99), "claude-sonnet-5-5");
  assert.equal(pickModel(6), null);
  assert.equal(pickModel(1, { DAILY_BUDGET_USD: "0.5" }), "claude-sonnet-5-5");

  const store = createMemoryStore();
  await store.addSpend(bishkekDay(DAY_14), 6.5);
  const client = fakeClient([]);
  const r = await botReply({ client, store, session: store.newSession("web:2"), text: "привет", actions: fakeActions(), now: DAY_14 });
  assert.equal(r.reply, TEXTS.overloaded);
  assert.equal(client.calls.length, 0);
});

test("стоимость: по цене модели, кэш дешевле, запасная модель по своей цене", () => {
  const opus = costOf({ model: "claude-opus-5-5", usage: { input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, "claude-opus-5-5");
  assert.equal(opus, 4);
  const cached = costOf({ model: "claude-opus-5-5", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 0 } });
  assert.ok(Math.abs(cached - 0.4) < 1e-9);
  const withFallback = costOf({ model: "claude-opus-5", usage: { iterations: [
    { type: "message", model: "claude-opus-5-5", input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { type: "fallback_message", model: "claude-sonnet-5-5", input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ] } });
  assert.equal(withFallback, 6);
  assert.equal(bishkekDay(new Date("2026-10-24T19:00:00Z")), "2026-10-25", "после 18:00 UTC в Бишкеке уже следующий день");
});

test("ночью бот знает, что менеджеры с 10:00", () => {
  const s = { source: "web", context: {} };
  assert.match(turnNote(s, NIGHT_2330, true), /23:30, нерабочее время: менеджеры на связи с 10:00/);
  assert.match(turnNote(s, DAY_14, false), /рабочее время менеджеров/);
});

test("отказ модели: вежливый текст и передача менеджеру не ломают историю", async () => {
  const store = createMemoryStore();
  const client = fakeClient([{ content: [], stop_reason: "refusal", model: "claude-opus-5-5", usage: usage() }]);
  const r = await botReply({ client, store, session: store.newSession("web:3"), text: "?", actions: fakeActions(), now: DAY_14 });
  assert.equal(r.reply, TEXTS.refused);
});

test("история обрезается с начала и всегда начинается с реплики посетителя", () => {
  const u = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
  const a = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] });
  const tr = { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] };
  const sys = { role: "system", content: "время" };
  const msgs = [u("1"), sys, a("1"), u("2"), sys, { role: "assistant", content: [{ type: "tool_use", id: "x", name: "handoff", input: {} }] }, tr, a("2")];
  const t = trimHistory(msgs, 3);
  assert.equal(t.length, 0, "в последних трёх нет начала реплики — лучше пустая история, чем сломанная");
  assert.deepEqual(trimHistory(msgs, 5)[0], u("2"));
  assert.deepEqual(visibleTranscript(msgs), [{ role: "user", text: "1" }, { role: "assistant", text: "1" }, { role: "user", text: "2" }, { role: "assistant", text: "2" }]);
});

test("системная инструкция: правила, база знаний, другие услуги без каталога", () => {
  const s = buildSystem([{ id: "catalog", title: "Каталоги", price: 30000 }, { id: "bot", title: "Чат-боты", price: 35000, term: "1–2 недели", short: "Отвечают 24/7" }]);
  assert.match(s, /# Правила/);
  assert.match(s, /# База знаний/);
  assert.match(s, /Чат-боты: от 35\s000 сом/);
  assert.doesNotMatch(s, /Каталоги: от 30/);
});

test("chatTurn: менеджер ведёт клиента — сообщение уходит в группу, Claude не вызывается", async () => {
  const store = createMemoryStore();
  const session = await telegramSession(store, { id: 77, username: "client" }, "telegram");
  await store.saveSession(session);
  await noteManagerReply(store, 77, "Добрый вечер, наберу вам завтра", DAY_14);
  const muted = await store.getSession("tg:77");
  const sent = [];
  const client = fakeClient([]);
  const r = await chatTurn({ env: {}, db: null, session: muted, text: "Хорошо", store, client, now: DAY_14, sendToGroup: async (t) => sent.push(t) });
  assert.equal(r.muted, true);
  assert.equal(client.calls.length, 0);
  assert.match(sent[0], /Клиент пишет \(@client\)/);
  assert.match(sent[0], /tg_id:77/);
  assert.match(muted.note, /Менеджер написал клиенту/);
});

test("chatTurn: пустой текст отклоняется, без ключа API — понятный ответ", async () => {
  const store = createMemoryStore();
  const s = store.newSession("web:4");
  assert.equal((await chatTurn({ env: {}, db: null, session: s, text: "   ", store, client: fakeClient([]), sendToGroup: async () => {} })).error, "bad_request");
  const r = await chatTurn({ env: {}, db: null, session: s, text: "привет", store, client: null, sendToGroup: async () => {} });
  assert.equal(r.error, "unavailable");
});

test("лендинг: неверный id сессии отклоняется, ниша и UTM чистятся", () => {
  assert.equal(parseWebPayload({ session: "../../x", message: "hi" }), null);
  const p = parseWebPayload({ session: "0f8fad5b-d9cb-469f-a165-70867728950e", message: "  привет ",
    context: { niche: "salon<script>", page: "https://x", utm: { source: "ig" }, quiz: { products: "До 30" }, lead_sent: true } });
  assert.equal(p.id, "web:0f8fad5b-d9cb-469f-a165-70867728950e");
  assert.equal(p.message, "привет");
  assert.equal(p.context.niche, "");
  assert.equal(p.context.utm.source, "ig");
  assert.deepEqual(p.context.quiz, { products: "До 30" });
  assert.equal(p.context.lead_sent, true);
});

test("карточка заявки: поля, оценка, tg_id для ответа менеджера", () => {
  const card = leadCard(LEAD, { source: "telegram", tg_id: 42, context: { username: "aigerim" } }, 1001);
  assert.match(card, /Заявка из чата №1001 · горячий/);
  assert.match(card, /Боль: не успевает отвечать/);
  assert.match(card, /Созвон\/встреча: созвон завтра в 11/);
  assert.match(card, /tg_id:42/);
  const web = leadCard({ ...LEAD, temperature: "warm" }, { source: "web", context: { page: "https://l/?niche=salon", utm: { source: "ig", campaign: "c1" } } }, 1002);
  assert.match(web, /тёплый/);
  assert.match(web, /UTM: ig \/ c1 \/ -/);
  assert.doesNotMatch(web, /tg_id/);
});

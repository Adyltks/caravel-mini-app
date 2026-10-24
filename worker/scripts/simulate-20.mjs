/* 20 разыгранных клиентов из разных сфер, которые пишут как живые люди: коротко, неохотно, могут молча уйти.
   Claude Sonnet 5.5 играет клиента, наш бот (Opus 5.5) продаёт. Telegram и база не используются.
   Запуск: ANTHROPIC_API_KEY в окружении, затем  node scripts/simulate-20.mjs [--max-cost 4] [--only id1,id2]
   Итог: scripts/simulate-20-result.txt */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { botReply } from "../src/bot/brain.js";
import { createMemoryStore } from "../src/bot/store.js";
import { leadCard } from "../src/bot/channels.js";
import { costOf } from "../src/bot/pricing.js";

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const MAX_COST = Number(arg("--max-cost", 4));
const ONLY = arg("--only", "") ? arg("--only").split(",") : null;
const MAX_TURNS = 12;
const PARALLEL = 4;
const CUSTOMER_MODEL = "claude-sonnet-5-5";
if (!process.env.ANTHROPIC_API_KEY) { console.error("Нет ANTHROPIC_API_KEY в окружении"); process.exit(1); }
const client = new Anthropic({ maxRetries: 2, timeout: 90_000 });

const DAY = new Date("2026-10-24T08:00:00Z"); // 14:00 Бишкек
const NIGHT = new Date("2026-10-24T17:40:00Z"); // 23:40 Бишкек
let personas = JSON.parse(readFileSync(new URL("./personas-20.json", import.meta.url), "utf8"));
if (ONLY) personas = personas.filter((p) => ONLY.includes(p.id));

// Живые услуги из мини-аппа (как их увидит бот в работе); при ошибке сети — без них
let services = [];
try {
  const r = await fetch("https://caravel-mini-app.adyltks.workers.dev/api/catalog");
  services = (await r.json()).services ?? [];
} catch (e) { console.warn("Услуги из мини-аппа не загрузились:", e.message); }

const customerSystem = (p) => `Ты играешь реального владельца малого бизнеса из Бишкека в переписке с чат-ботом агентства. Ты пришёл по рекламе в Instagram и пишешь с телефона между делами.
Кто ты: ${p.who}
Твой настрой (бот его не знает): ${p.intent}
Твой контакт, если решишь его дать: ${p.contact}

Как пишут такие люди, и как пишешь ты:
- Очень коротко: обычно 1-6 слов. «цена?», «а сколько», «ок», «понятно», «дорого», «посмотрю», «а это что», «+». Иногда одно предложение. Длинно не пишешь никогда.
- Без заглавных и точек, бывают опечатки. Без списков и вежливых оборотов.
- Сам о себе ничего не рассказываешь. Отвечаешь только на прямой вопрос, и то коротко, иногда уклончиво («ну около того», «не считал»).
- Иногда игнорируешь вопрос бота и спрашиваешь своё.
- Длинные сообщения бота тебя утомляют: если бот пишет простыню текста или давит, ты теряешь интерес.
- Контакт даёшь, только если тебе правда стало интересно и бот попросил. Если настрой «не даёт», контакт не даёшь никогда.
- Если тебе стало скучно, неинтересно, дорого или бот надоел, ты просто перестаёшь отвечать: тогда напиши ровно [МОЛЧУ] и больше ничего.
- Если дал контакт и тебе ответили, можешь закончить: напиши короткое «ок спс» и в конце [КОНЕЦ].`;

const results = [];
let total = 0;

async function runPersona(p) {
  const log = [`\n==================== ${p.id} (${p.source}, ${p.night ? "23:40" : "14:00"}) ====================`, `Кто: ${p.who}`, `Настрой: ${p.intent}`];
  const now = p.night ? NIGHT : DAY;
  const store = createMemoryStore();
  const session = store.newSession(p.source === "telegram" ? `tg:${p.id}` : `web:${p.id}`, {
    source: p.source, tg_id: p.source === "telegram" ? 777 : null,
    context: { niche: p.niche, page: `https://catalog-landing.adyltks.workers.dev/${p.niche ? `?niche=${p.niche}` : ""}`, utm: { source: "instagram", campaign: "test20", content: p.id } },
  });
  const leads = [];
  const handoffs = [];
  const actions = {
    createLead: async (input, s) => { leads.push(leadCard(input, s, 9100 + results.length)); return { id: 9100 + results.length }; },
    updateLead: async (input) => { handoffs.push(`дополнение к заявке: ${input.meeting || input.summary}`); },
    handoff: async (input) => { handoffs.push(`${input.reason}: ${input.question}`); },
  };
  const customerMsgs = [{ role: "user", content: "[Ты открыл чат с ботом после рекламы. Напиши первое сообщение.]" }];
  let botCost = 0, custCost = 0, turns = 0, outcome = "лимит реплик";

  for (; turns < MAX_TURNS; turns++) {
    if (total >= MAX_COST) { outcome = "стоп по бюджету"; break; }
    const c = await client.messages.create({ model: CUSTOMER_MODEL, max_tokens: 1500, output_config: { effort: "low" }, system: customerSystem(p), messages: customerMsgs });
    const cc = costOf(c, CUSTOMER_MODEL); custCost += cc; total += cc;
    const said = c.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    if (said.includes("[МОЛЧУ]")) { log.push(`\nКЛИЕНТ: …(перестал отвечать)`); outcome = `ушёл молча после ${turns} ответов бота`; break; }
    const done = said.includes("[КОНЕЦ]");
    const text = said.replace("[КОНЕЦ]", "").trim() || "ок";
    customerMsgs.push({ role: "assistant", content: said });
    log.push(`\nКЛИЕНТ: ${text}`);

    const t0 = Date.now();
    const r = await botReply({ client, store, session, text, actions, now, services, settings: { currency: "сом" } });
    botCost += r.costUsd; total += r.costUsd;
    log.push(`БОТ [${((Date.now() - t0) / 1000).toFixed(0)} с, ${r.reply.length} зн.]: ${r.reply}`);
    if (r.toolCalls.some((t) => t.name === "create_lead")) log.push("   [бот создал заявку]");
    if (r.toolCalls.some((t) => t.name === "handoff")) log.push("   [бот позвал менеджера]");
    if (done) { outcome = "закончил разговор"; turns++; break; }
    customerMsgs.push({ role: "user", content: r.reply });
  }
  log.push(`\n--- Итог ${p.id}: ${leads.length ? "ЗАЯВКА" : "без заявки"}, ${outcome}; бот $${botCost.toFixed(3)}, клиент-актёр $${custCost.toFixed(3)}`);
  if (handoffs.length) log.push(`--- Позвал менеджера: ${handoffs.join(" | ")}`);
  if (leads.length) log.push(`--- Карточка в группе:\n${leads.join("\n\n")}`);
  results.push({ id: p.id, intent: p.intent.split(":")[0], lead: leads.length > 0, handoff: handoffs.length > 0, outcome, turns, botCost, log: log.join("\n") });
  console.log(`${p.id}: ${leads.length ? "ЗАЯВКА" : "—"} (${outcome}), всего $${total.toFixed(2)}`);
}

// Параллельно по PARALLEL диалогов
const queue = [...personas];
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  while (queue.length) {
    const p = queue.shift();
    try { await runPersona(p); } catch (e) {
      results.push({ id: p.id, intent: "", lead: false, handoff: false, outcome: `ошибка: ${e.message}`, turns: 0, botCost: 0, log: `\n${p.id}: ошибка ${e.message}` });
      console.error(`${p.id}: ошибка ${e.message}`);
    }
  }
}));

const order = personas.map((p) => p.id);
results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const leadsN = results.filter((r) => r.lead).length;
const summary = [
  `ИТОГ: заявок ${leadsN} из ${results.length}; позвал менеджера в ${results.filter((r) => r.handoff).length}; ушли молча: ${results.filter((r) => r.outcome.startsWith("ушёл")).length}`,
  `Потрачено всего $${total.toFixed(2)} (бот $${results.reduce((s, r) => s + r.botCost, 0).toFixed(2)})`,
  "",
  ...results.map((r) => `${r.lead ? "✅" : "❌"} ${r.id.padEnd(16)} ${r.intent.padEnd(22)} ${r.outcome}, реплик ${r.turns}`),
].join("\n");
writeFileSync(new URL("./simulate-20-result.txt", import.meta.url), summary + "\n" + results.map((r) => r.log).join("\n") + "\n");
console.log("\n" + summary);

/* Короткая проверка бота на настоящем Claude API (4 реплики владелицы салона ночью, ~$0.05–0.15).
   База и Telegram не используются: хранилище в памяти, заявки только печатаются.
   Запуск: ключ в переменной окружения ANTHROPIC_API_KEY (не в файлах!), затем  node scripts/smoke-bot.mjs
   Результат пишется в scripts/smoke-result.txt (без ключа). */
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync } from "node:fs";
import { botReply } from "../src/bot/brain.js";
import { createMemoryStore } from "../src/bot/store.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Нет ANTHROPIC_API_KEY в окружении");
  process.exit(1);
}
const client = new Anthropic({ maxRetries: 1, timeout: 60_000 });
const store = createMemoryStore();
const session = store.newSession("web:smoke", { source: "web", context: { niche: "salon", page: "https://catalog-landing.adyltks.workers.dev/?niche=salon" } });
const actions = {
  createLead: async (input) => { log.push(`  [create_lead] ${JSON.stringify(input)}`); return { id: 9001 }; },
  handoff: async (input) => { log.push(`  [handoff] ${JSON.stringify(input)}`); },
};
const services = [{ id: "bot", title: "Чат-боты в Telegram", price: 35000, term: "1–2 недели", short: "Отвечают клиентам 24/7", kind: "service" }];
const night = new Date("2026-10-24T17:30:00Z"); // 23:30 в Бишкеке

const turns = [
  "Здравствуйте, у меня салон, ногти и брови",
  "Записываются в директе, я не успеваю отвечать, особенно вечером. Услуг штук 25",
  "А сколько стоит и что вы сделаете?",
  "Давайте, меня зовут Айгерим, +996 555 000 001, удобно созвониться завтра после обеда",
];
const log = [];
let total = 0;
for (const text of turns) {
  log.push(`КЛИЕНТ: ${text}`);
  const t0 = Date.now();
  const r = await botReply({ client, store, session, text, actions, now: night, services, settings: { currency: "сом" } });
  total += r.costUsd;
  log.push(`БОТ (${r.model}, ${((Date.now() - t0) / 1000).toFixed(1)} с, $${r.costUsd.toFixed(4)}, из кэша ${r.cacheRead} токенов): ${r.reply}`);
  for (const c of r.toolCalls) log.push(`  [инструмент] ${c.name}`);
}
log.push(`\nИтого: $${total.toFixed(4)}`);
writeFileSync(new URL("./smoke-result.txt", import.meta.url), log.join("\n") + "\n");
console.log(log.join("\n"));

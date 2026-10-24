/* Разыгранные клиенты: Claude Sonnet 5.5 играет владельца бизнеса, наш бот (Opus 5.5) продаёт.
   Ничего не уходит в Telegram и базу: хранилище в памяти, заявка печатается так, как её увидит группа.
   Запуск: ANTHROPIC_API_KEY в окружении (не в файлах!), затем  node scripts/simulate-leads.mjs [--max-cost 2]
   Итог: scripts/simulate-result.txt */
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync } from "node:fs";
import { botReply } from "../src/bot/brain.js";
import { createMemoryStore } from "../src/bot/store.js";
import { leadCard } from "../src/bot/channels.js";
import { costOf } from "../src/bot/pricing.js";

const MAX_COST = Number(process.argv[process.argv.indexOf("--max-cost") + 1]) || 2;
const MAX_TURNS = 10;
const CUSTOMER_MODEL = "claude-sonnet-5-5";
if (!process.env.ANTHROPIC_API_KEY) { console.error("Нет ANTHROPIC_API_KEY в окружении"); process.exit(1); }
const client = new Anthropic({ maxRetries: 2, timeout: 90_000 });

const DAY = new Date("2026-10-24T08:00:00Z"); // 14:00 Бишкек
const NIGHT = new Date("2026-10-24T17:40:00Z"); // 23:40 Бишкек
const services = [
  { id: "bot", title: "Чат-боты в Telegram", price: 35000, term: "1–2 недели", short: "Отвечают клиентам 24/7", kind: "service" },
  { id: "ads", title: "Таргет в Instagram", price: 30000, term: "ежемесячно", short: "Реклама, которая приводит клиентов", kind: "service" },
  { id: "landing", title: "Лендинги", price: 25000, term: "5–7 дней", short: "Продающая страница под рекламу", kind: "service" },
];

const PERSONAS = [
  { id: "salon-night", now: NIGHT, source: "web", niche: "salon",
    who: "Айгерим, 29 лет, свой маникюрный салон в Бишкеке на 3 мастера: маникюр, педикюр, брови. Записи только через директ Instagram, вечером после работы не успеваешь отвечать, клиентки уходят к другим. Услуг около 25. Пишешь коротко, с телефона, иногда без запятых. Немного сомневаешься, что это нужно, но устала от переписки.",
    contact: "Айгерим, WhatsApp +996 555 000 011. Удобно созвониться завтра после 15:00." },
  { id: "cosmetics-price", now: DAY, source: "web", niche: "cosmetics",
    who: "Нурлан, продаёт корейскую косметику через Instagram, около 150 товаров, у многих по 2-3 объёма. Заказы в директе и WhatsApp, путаница с ценами. В первую очередь хочешь узнать цену и считаешь, что 20-25 тысяч дорого. Спрашиваешь про скидку. Соглашаешься на созвон, только если поймёшь, что окупится.",
    contact: "Нурлан, WhatsApp +996 555 000 012, созвон в понедельник утром." },
  { id: "flowers-rush", now: DAY, source: "telegram", niche: "gifts",
    who: "Диана, цветочный магазин, букеты и подарочные боксы. Скоро 8 Марта (но сейчас осень, ты планируешь заранее) и Новый год. Заказы по телефону и в директе, теряются адреса и время доставки. Торопишься, пишешь быстро. Хочешь понять сроки.",
    contact: "Диана, пиши в этот Telegram, лучше встретиться лично в Бишкеке на неделе." },
  { id: "taplink-skeptic", now: DAY, source: "web", niche: "",
    who: "Владелец магазина одежды, имя не говоришь сразу. Уже есть Taplink и каталог в WhatsApp Business. Скептичен: зачем ещё что-то. Задаёшь острые вопросы, проверяешь, не врёт ли бот. Можешь так и не оставить контакт, если не убедят.",
    contact: "Если убедят: Эрлан, +996 555 000 014, только созвон вечером." },
  { id: "dentist-other", now: NIGHT, source: "web", niche: "",
    who: "Администратор стоматологии. Хочешь, чтобы пациенты записывались онлайн, и спрашиваешь про календарь свободных окон и напоминания. Ниша не из списка агентства. Пишешь вежливо и подробно.",
    contact: "Гульнара, администратор, +996 555 000 015, звонить в рабочее время." },
];

const customerSystem = (p) => `Ты играешь потенциального клиента в переписке с чат-ботом агентства, которое делает каталоги и сайты для бизнеса из Instagram.
Кто ты: ${p.who}
Твои контакты, если решишь их дать: ${p.contact}
Правила игры:
- Пиши как живой человек в мессенджере: по-русски, 1-3 коротких предложения, без списков.
- Отвечай на вопросы бота правдиво по своей роли, детали придумывай в рамках роли.
- Не будь слишком покладистым: веди себя так, как вёл бы себя такой человек.
- Контакт давай только если бот убедил тебя, что созвон или встреча тебе полезны.
- Когда разговор логически закончен (ты дал контакт и тебе ответили, или решил уйти), напиши последнее сообщение и в конце добавь [КОНЕЦ].`;

const out = [];
let total = 0;
const say = (s) => { out.push(s); console.log(s); };

for (const p of PERSONAS) {
  if (total >= MAX_COST) { say(`\nСтоп: потрачено $${total.toFixed(2)} из $${MAX_COST}`); break; }
  say(`\n==================== ${p.id} (${p.source}, ${p.now === NIGHT ? "23:40" : "14:00"}) ====================`);
  const store = createMemoryStore();
  const session = store.newSession(p.source === "telegram" ? "tg:555" : `web:${p.id}`, {
    source: p.source, tg_id: p.source === "telegram" ? 555 : null,
    context: { niche: p.niche, page: `https://catalog-landing.adyltks.workers.dev/${p.niche ? `?niche=${p.niche}` : ""}`, utm: { source: "instagram", campaign: "test", content: p.id } },
  });
  const leads = [];
  const actions = {
    createLead: async (input, s) => { leads.push(leadCard(input, s, 9000 + leads.length)); return { id: 9000 + leads.length }; },
    updateLead: async (input) => { say(`   [дополнение к заявке] ${input.meeting || input.summary}`); },
    handoff: async (input) => { say(`   [бот позвал менеджера] ${input.reason}: ${input.question}`); },
  };
  const customerMsgs = [{ role: "user", content: "[Ты открыл чат с ботом. Напиши первое сообщение.]" }];
  let botCost = 0, custCost = 0;

  for (let i = 0; i < MAX_TURNS && total < MAX_COST; i++) {
    const c = await client.messages.create({
      model: CUSTOMER_MODEL, max_tokens: 1000, output_config: { effort: "low" },
      system: customerSystem(p), messages: customerMsgs,
    });
    const cc = costOf(c, CUSTOMER_MODEL); custCost += cc; total += cc;
    const said = c.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const done = said.includes("[КОНЕЦ]");
    const text = said.replace("[КОНЕЦ]", "").trim();
    customerMsgs.push({ role: "assistant", content: said || "..." });
    if (text) say(`\nКЛИЕНТ: ${text}`);
    if (done && !text) break;

    const t0 = Date.now();
    const r = await botReply({ client, store, session, text: text || "...", actions, now: p.now, services, settings: { currency: "сом" } });
    botCost += r.costUsd; total += r.costUsd;
    say(`БОТ [${((Date.now() - t0) / 1000).toFixed(0)} с]: ${r.reply}`);
    for (const tc of r.toolCalls) if (tc.name === "create_lead") say("   [бот создал заявку]");
    if (done) break;
    customerMsgs.push({ role: "user", content: r.reply });
  }
  say(`\n--- Итог ${p.id}: бот $${botCost.toFixed(3)}, клиент-актёр $${custCost.toFixed(3)}`);
  if (leads.length) say(`--- Карточка в группе:\n${leads.join("\n\n")}`);
  else say("--- Заявки нет");
}
say(`\nВсего потрачено: $${total.toFixed(2)}`);
writeFileSync(new URL("./simulate-result.txt", import.meta.url), out.join("\n") + "\n");

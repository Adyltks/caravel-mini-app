// Запускатель проверки бота aduka.ai на разыгранных клиентах.
// Бот: botReply из ../src/bot/brain.js. Клиент: Claude Sonnet 5.5 (effort low). Судья: Claude Opus 5.5 (effort medium).
// ВНИМАНИЕ: без --dry каждый прогон тратит деньги API. Ключ - только в переменной окружения ANTHROPIC_API_KEY.
//
//   node eval/run.mjs --dry                      проверка самого запускателя без сети (заглушки)
//   node eval/run.mjs --persona cosmetics-ideal-day --max-cost 1
//   node eval/run.mjs --max-cost 8               полный прогон (оценка стоимости - в README)
//   флаги: --persona id[,id]  --dry  --max-cost N (по умолчанию 3)  --turns N (по умолчанию 12)  --no-judge

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKnowledge, checkTranscript, summarize, isNight, PREMIUM_NICHES } from "./checks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const CLIENT_MODEL = "claude-sonnet-5-5";
const JUDGE_MODEL = "claude-opus-5-5";
// Цены за 1 млн токенов (ввод / вывод). Кэш: чтение 0.1x ввода, запись 1.25x ввода. Перепроверять перед прогоном.
const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
};
const BOT_ENV = { DAILY_BUDGET_USD: "3", BOT_EFFORT: "low" };
const END_MARK = "[КОНЕЦ]";
const JUDGE_IDS = ["M1", "M2", "M3", "M7", "D1", "D2", "D3", "D6", "D7", "D10", "D11"];

// ---------- Аргументы ----------

function parseArgs(argv) {
  const args = { dry: false, personas: [], maxCost: 3, turns: 12, judge: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") args.dry = true;
    else if (a === "--no-judge") args.judge = false;
    else if (a === "--persona") args.personas.push(...String(argv[++i] || "").split(",").filter(Boolean));
    else if (a === "--max-cost") args.maxCost = Number(argv[++i]);
    else if (a === "--turns") args.turns = Number(argv[++i]);
    else throw new Error("Неизвестный флаг: " + a);
  }
  if (!(args.maxCost > 0)) throw new Error("--max-cost должен быть числом больше 0");
  if (!(args.turns >= 1 && args.turns <= 30)) throw new Error("--turns от 1 до 30");
  return args;
}

// ---------- Время Бишкека (UTC+6, без перехода на летнее время) ----------

function bishkekDate(hhmm, plusMinutes = 0) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const nowB = new Date(Date.now() + 6 * 3600e3);
  const utc = Date.UTC(nowB.getUTCFullYear(), nowB.getUTCMonth(), nowB.getUTCDate(), hh - 6, mm + plusMinutes);
  return new Date(utc);
}
function bishkekStamp() {
  const d = new Date(Date.now() + 6 * 3600e3);
  return d.toISOString().slice(0, 10);
}

// ---------- Деньги ----------

function costFromUsage(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return 0;
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  return (inTok * p.input + outTok * p.output + cacheRead * p.input * 0.1 + cacheWrite * p.input * 1.25) / 1e6;
}

class Budget {
  constructor(max) { this.max = max; this.spent = { bot: 0, client: 0, judge: 0 }; }
  add(role, usd) { this.spent[role] += Number(usd) || 0; }
  get total() { return this.spent.bot + this.spent.client + this.spent.judge; }
  get exceeded() { return this.total >= this.max; }
}

// ---------- Персоны ----------

function loadPersonas() {
  const data = JSON.parse(readFileSync(join(HERE, "personas.json"), "utf8"));
  const list = data.personas || [];
  const errors = [];
  const ids = new Set();
  const required = ["id", "niche", "channel", "timeOfDay", "time", "context", "name", "manner", "style", "knows", "wants", "opening", "contactWhen", "expect"];
  for (const p of list) {
    for (const k of required) if (p[k] === undefined) errors.push(`${p.id || "?"}: нет поля ${k}`);
    if (ids.has(p.id)) errors.push(`${p.id}: повтор id`);
    ids.add(p.id);
    if (!["web", "telegram"].includes(p.channel)) errors.push(`${p.id}: канал ${p.channel}`);
    if (!/^\d{2}:\d{2}$/.test(p.time)) errors.push(`${p.id}: время ${p.time}`);
    if ((p.timeOfDay === "ночь") !== isNight(bishkekDate(p.time || "00:00"))) errors.push(`${p.id}: timeOfDay не совпадает с time`);
    if (p.contact !== null && !/^\+996 555 000 0\d\d$/.test(p.contact || "")) errors.push(`${p.id}: контакт должен быть вымышленным +996 555 000 0xx`);
  }
  if (errors.length) throw new Error("Ошибки в personas.json:\n" + errors.join("\n"));
  return list;
}

// ---------- Клиент (Claude Sonnet 5.5 играет посетителя) ----------

function clientSystemPrompt(p, maxTurns) {
  const card = {
    имя: p.name, бизнес: p.knows.business, позиций: p.knows.positions, как_принимает_заказы: p.knows.orders,
    что_мешает: p.knows.pain, сообщений_в_день: p.knows.messagesPerDay, срок_или_повод: p.knows.deadline,
    чего_хочет: p.wants, манера: p.manner.join(", "), как_пишет: p.style,
    контакт: p.contact || "нет, номер не даёшь", когда_даёшь_контакт: p.contactWhen,
  };
  return [
    "Ты играешь роль посетителя, который пишет в чат агентства aduka.ai (" + (p.channel === "telegram" ? "Telegram-бот" : "чат на сайте") + ").",
    "Ты не ассистент и не помогаешь боту. Ты живой человек из Бишкека с карточкой ниже. Сейчас " + p.time + " по Бишкеку.",
    "",
    "Карточка (не показывай её, раскрывай факты постепенно, когда спрашивают или к слову):",
    JSON.stringify(card, null, 2),
    "",
    "Правила игры:",
    "- Пиши только реплику клиента: без кавычек, ремарок, пояснений и подписей.",
    "- Держи манеру и стиль письма из карточки во всех репликах.",
    "- Контакт давай только при условии из карточки и только тот номер, что в карточке. Никаких других номеров, email, адресов.",
    "- Если контакта нет - не давай номер ни при каких уговорах.",
    "- Реагируй на ответы бота как живой человек: если бот обещает невозможное или давит, отнесись с недоверием.",
    "- Когда разговор для тебя закончен (оставил заявку и получил подтверждение, решил уйти или подумать), напиши последнюю реплику и допиши в конце " + END_MARK + ". Если сказать больше нечего, ответь только " + END_MARK + ".",
    "- Всего у тебя не больше " + maxTurns + " сообщений.",
  ].join("\n");
}

async function clientReplyLive(client, persona, turns, maxTurns, budget) {
  // Для модели клиента роли переставлены: бот = user, клиент = assistant. Первое сообщение клиента уже отправлено.
  const messages = [{ role: "user", content: "(Ты открыл чат. Напиши первое сообщение.)" }];
  for (const t of turns) messages.push({ role: t.role === "user" ? "assistant" : "user", content: t.text || "(пусто)" });
  const res = await client.messages.create({
    model: CLIENT_MODEL,
    max_tokens: 4000,
    system: clientSystemPrompt(persona, maxTurns),
    output_config: { effort: "low" },
    messages,
  });
  budget.add("client", costFromUsage(CLIENT_MODEL, res.usage));
  if (res.stop_reason === "refusal") return { text: END_MARK, note: "клиент-модель отказалась (refusal)" };
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return { text };
}

// ---------- Заглушки для --dry ----------

function clientReplyDry(persona, turnIndex) {
  const k = persona.knows;
  const script = [
    persona.opening,
    k.orders,
    k.pain,
    k.positions,
    persona.contact ? `${persona.name}, ${persona.contact}` : "Спасибо, я подумаю",
    "Спасибо! " + END_MARK,
  ];
  return { text: script[Math.min(turnIndex, script.length - 1)] };
}

function makeDryBot(kb) {
  const counters = new Map();
  return async function botReply({ session, text, actions, now }) {
    const n = (counters.get(session.id) || 0) + 1;
    counters.set(session.id, n);
    const niche = session.context?.niche || "";
    const premium = PREMIUM_NICHES.has(niche);
    const tiers = premium && kb.premium ? kb.premium : kb.tiers;
    const fmt = (x) => x.toLocaleString("ru-RU").replace(/\s/g, " ");
    const nightLine = isNight(now) ? " Менеджеры на связи с 10:00, заявку возьмут первой." : "";
    const toolCalls = [];
    let reply;
    let lead = false;
    const phone = text.match(/\+?996[\s\d]{9,}/);
    if (phone) {
      const input = { niche: niche || "не указана", name: text.split(",")[0].trim(), contact: phone[0].trim(), pain: "из диалога", current_channel: "из диалога", positions: "из диалога", temperature: "тёплый" };
      await actions.createLead(input, session);
      toolCalls.push({ name: "create_lead", input });
      lead = true;
      reply = "Спасибо! Передаю заявку менеджеру." + nightLine;
    } else if (n === 1) {
      reply = "Здравствуйте! Как вы сейчас принимаете заказы?";
    } else if (n === 2) {
      reply = "Понял. Что в этом мешает больше всего?";
    } else if (n === 3) {
      const demo = kb.demos[niche];
      reply = (demo ? `Вот демо вашей ниши: ${demo} ` : "") + "Сколько у вас примерно позиций?";
    } else if (n === 4) {
      reply = `Подойдёт тариф «Магазин», ${fmt(tiers.magazin.price)} сом, точную цену назовёт менеджер на созвоне. Как вас зовут и куда написать?`;
    } else {
      reply = "Хорошо. Если появятся вопросы, пишите в любое время.";
    }
    return { reply, lead, model: "dry-stub", costUsd: 0, toolCalls };
  };
}

function dryJudge() {
  const criteria = Object.fromEntries(JUDGE_IDS.map((id) => [id, { verdict: "na", reason: "заглушка --dry" }]));
  return { criteria, lead_quality: "нет заявки", summary: "Судья не вызывался (--dry)." };
}

function createFallbackStore() {
  const sessions = new Map(), messages = new Map(), spend = new Map();
  return {
    async getSession(id) { return sessions.get(id) || null; },
    async saveSession(s) { sessions.set(s.id, s); },
    async getMessages(id) { return messages.get(id) || []; },
    async appendMessages(id, msgs) { messages.set(id, [...(messages.get(id) || []), ...msgs]); },
    async getSpend(day) { return spend.get(day) || 0; },
    async addSpend(day, usd) { spend.set(day, (spend.get(day) || 0) + usd); },
  };
}

// ---------- Судья (Claude Opus 5.5) ----------

function judgeSchema() {
  const verdict = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "reason"],
    properties: { verdict: { type: "string", enum: ["pass", "fail", "na"] }, reason: { type: "string" } },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["criteria", "lead_quality", "summary"],
    properties: {
      criteria: {
        type: "object",
        additionalProperties: false,
        required: JUDGE_IDS,
        properties: Object.fromEntries(JUDGE_IDS.map((id) => [id, verdict])),
      },
      lead_quality: { type: "string", enum: ["нет заявки", "слабая", "хорошая"] },
      summary: { type: "string" },
    },
  };
}

function judgeSystemPrompt(kb, rubric) {
  return [
    "Ты строгий и справедливый проверяющий диалогов ИИ-бота-продавца агентства aduka.ai.",
    "Оцени диалог по рубрике. Факты сверяй только с базой знаний: всё, чего в ней нет, бот говорить не должен.",
    "Оценивай только критерии " + JUDGE_IDS.join(", ") + ". verdict: pass, fail или na (критерий к диалогу не относится).",
    "reason - одна короткая фраза по-русски с номером реплики, например «#5: назвал скидку 20%».",
    "Ответ - только JSON по заданной схеме.",
    "",
    "<rubric>", rubric, "</rubric>",
    "", "<knowledge_base>", kb.adukaText, "</knowledge_base>",
    "", "<bot_rules>", kb.rulesText, "</bot_rules>",
  ].join("\n");
}

function transcriptForJudge(persona, transcript, now) {
  const lines = transcript.turns.map((t, i) => `#${i} ${t.role === "user" ? "КЛИЕНТ" : "БОТ"}: ${t.text}`);
  const tools = transcript.toolCalls.map((c) => `#${c.turn ?? "?"} ${c.name} ${JSON.stringify(c.input)}`);
  return [
    "Карточка клиента (что он знает и чего ждём от бота):",
    JSON.stringify({ id: persona.id, niche: persona.niche, nicheLabel: persona.nicheLabel, manner: persona.manner, knows: persona.knows, wants: persona.wants, contactWhen: persona.contactWhen, expect: persona.expect }, null, 2),
    "",
    `Канал: ${persona.channel}. Время у клиента: ${persona.time} по Бишкеку (${isNight(now) ? "менеджеры не на связи" : "рабочее время"}).`,
    "",
    "<transcript>", ...lines, "</transcript>",
    "", "<tool_calls>", ...(tools.length ? tools : ["(нет)"]), "</tool_calls>",
  ].join("\n");
}

async function judgeLive(client, kb, rubric, persona, transcript, now, budget) {
  const res = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 16000,
    // База знаний и рубрика одинаковы для всех персон - кэшируем этот префикс.
    system: [{ type: "text", text: judgeSystemPrompt(kb, rubric), cache_control: { type: "ephemeral" } }],
    output_config: { effort: "medium", format: { type: "json_schema", schema: judgeSchema() } },
    messages: [{ role: "user", content: transcriptForJudge(persona, transcript, now) }],
  });
  budget.add("judge", costFromUsage(JUDGE_MODEL, res.usage));
  if (res.stop_reason === "refusal") return { error: "судья отказался (refusal)" };
  if (res.stop_reason === "max_tokens") return { error: "судья упёрся в max_tokens" };
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(text);
  } catch {
    return { error: "судья вернул не JSON", raw: text.slice(0, 500) };
  }
}

// ---------- Один диалог ----------

async function runPersona({ persona, args, kb, rubric, budget, client, botReply, makeStore }) {
  const startNow = bishkekDate(persona.time);
  const session = { id: `eval-${persona.id}-${Date.now()}`, source: persona.channel, context: persona.context };
  const store = makeStore();
  const turns = [];
  const executed = [];
  const reported = [];
  const models = new Set();
  let stopReason = "лимит реплик";
  let error = null;

  const actions = {
    async createLead(input, s) {
      executed.push({ name: "create_lead", input, turn: turns.length });
      return { id: `eval-lead-${persona.id}-${executed.length}` };
    },
    async updateLead(input, s) {
      executed.push({ name: "update_lead", input, turn: turns.length });
    },
    async handoff(input, s) {
      executed.push({ name: "handoff", input, turn: turns.length });
    },
  };

  try {
    for (let k = 0; k < args.turns; k++) {
      if (budget.exceeded) { stopReason = "лимит стоимости"; break; }
      const c = k === 0 ? { text: persona.opening } : args.dry ? clientReplyDry(persona, k) : await clientReplyLive(client, persona, turns, args.turns, budget);
      let text = (c.text || "").trim();
      const ended = text.includes(END_MARK);
      text = text.replace(END_MARK, "").trim();
      if (!text) { stopReason = c.note || "клиент закончил"; break; }
      turns.push({ role: "user", text });
      if (budget.exceeded) { stopReason = "лимит стоимости"; break; }

      const now = new Date(startNow.getTime() + k * 60e3);
      const res = await botReply({ client, env: BOT_ENV, store, session, text, actions, now });
      budget.add("bot", res.costUsd);
      if (res.model) models.add(res.model);
      turns.push({ role: "assistant", text: res.reply || "", model: res.model, lead: Boolean(res.lead) });
      for (const tc of res.toolCalls || []) reported.push({ ...tc, turn: turns.length - 1 });
      if (ended) { stopReason = c.note || "клиент закончил"; break; }
    }
  } catch (e) {
    error = String(e?.stack || e);
    stopReason = "ошибка";
  }

  // Источник правды - реально выполненные действия; если бот их не вызывал, берём то, что он вернул в toolCalls.
  const toolCalls = executed.length ? executed : reported;
  const transcript = { turns, toolCalls };
  const night = isNight(startNow);
  const violations = checkTranscript(transcript, kb, { persona, niche: persona.niche, night });

  let judge = null;
  if (args.judge && turns.length && !error) {
    if (args.dry) judge = dryJudge();
    else if (budget.exceeded) judge = { error: "пропущен: лимит стоимости" };
    else {
      try { judge = await judgeLive(client, kb, rubric, persona, transcript, startNow, budget); }
      catch (e) { judge = { error: String(e?.message || e) }; }
    }
  }

  const judgeFails = judge?.criteria ? Object.entries(judge.criteria).filter(([, x]) => x.verdict === "fail").map(([id]) => id) : [];
  return {
    id: persona.id,
    niche: persona.niche,
    time: persona.time,
    night,
    channel: persona.channel,
    models: [...models],
    stopReason,
    error,
    leadCreated: toolCalls.some((c) => c.name === "create_lead"),
    handoff: toolCalls.some((c) => c.name === "handoff"),
    expect: persona.expect,
    transcript,
    violations,
    violationSummary: summarize(violations),
    judge,
    judgeFails,
    failed: Boolean(error) || violations.some((x) => x.level === "mandatory") || judgeFails.some((id) => id.startsWith("M")),
  };
}

// ---------- Главная ----------

function resultPath(dry) {
  const dir = join(HERE, "results");
  mkdirSync(dir, { recursive: true });
  const base = bishkekStamp() + (dry ? "-dry" : "");
  let file = join(dir, base + ".json");
  for (let n = 2; existsSync(file); n++) file = join(dir, `${base}-${n}.json`);
  return file;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kb = loadKnowledge();
  const rubric = readFileSync(join(HERE, "rubric.md"), "utf8");
  let personas = loadPersonas();
  if (args.personas.length) {
    const unknown = args.personas.filter((id) => !personas.some((p) => p.id === id));
    if (unknown.length) throw new Error("Нет таких персон: " + unknown.join(", "));
    personas = personas.filter((p) => args.personas.includes(p.id));
  }

  let client = null, botReply, makeStore;
  if (args.dry) {
    botReply = makeDryBot(kb);
    makeStore = createFallbackStore;
  } else {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("Нет ANTHROPIC_API_KEY в окружении. Для проверки без сети: --dry");
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic();
    let brain, storeMod;
    try {
      brain = await import("../src/bot/brain.js");
    } catch (e) {
      throw new Error("Не загрузился ../src/bot/brain.js (его пишет руководитель): " + e.message);
    }
    if (typeof brain.botReply !== "function") throw new Error("В brain.js нет функции botReply");
    botReply = brain.botReply;
    try {
      storeMod = await import("../src/bot/store.js");
    } catch {
      storeMod = null;
    }
    makeStore = typeof storeMod?.createMemoryStore === "function" ? storeMod.createMemoryStore : createFallbackStore;
    if (!storeMod) console.warn("Предупреждение: нет ../src/bot/store.js, использую простое хранилище в памяти.");
  }

  const budget = new Budget(args.maxCost);
  const startedAt = new Date().toISOString();
  console.log(`Персон: ${personas.length}. Режим: ${args.dry ? "dry (без сети)" : "живой"}. Лимит: $${args.maxCost}. Реплик клиента: до ${args.turns}.`);

  const results = [];
  for (const persona of personas) {
    if (budget.exceeded) {
      results.push({ id: persona.id, skipped: true, stopReason: "лимит стоимости" });
      continue;
    }
    const before = budget.total;
    const r = await runPersona({ persona, args, kb, rubric, budget, client, botReply, makeStore });
    r.costUsd = Number((budget.total - before).toFixed(4));
    results.push(r);
    const s = r.violationSummary;
    console.log(
      `${r.failed ? "ПРОВАЛ" : "ок    "} ${r.id.padEnd(32)} заявка:${r.leadCreated ? "да " : "нет"} handoff:${r.handoff ? "да " : "нет"} ` +
      `обяз:${s.mandatory} желат:${s.desirable} судья-fail:${r.judgeFails.join(",") || "-"} $${r.costUsd.toFixed(3)} (${r.stopReason})`
    );
    if (r.error) console.log("   ошибка: " + r.error.split("\n")[0]);
  }

  const ran = results.filter((r) => !r.skipped);
  const expectedLead = ran.filter((r) => r.expect?.lead === true);
  const summary = {
    personas: results.length,
    ran: ran.length,
    skipped: results.length - ran.length,
    leads: ran.filter((r) => r.leadCreated).length,
    leadsWhenExpected: `${expectedLead.filter((r) => r.leadCreated).length}/${expectedLead.length}`,
    failed: ran.filter((r) => r.failed).length,
    errors: ran.filter((r) => r.error).length,
    mandatoryViolations: ran.reduce((n, r) => n + r.violationSummary.mandatory, 0),
    desirableViolations: ran.reduce((n, r) => n + r.violationSummary.desirable, 0),
    byId: ran.reduce((acc, r) => { for (const [k, c] of Object.entries(r.violationSummary.byId)) acc[k] = (acc[k] || 0) + c; return acc; }, {}),
    costUsd: { total: Number(budget.total.toFixed(4)), ...Object.fromEntries(Object.entries(budget.spent).map(([k, x]) => [k, Number(x.toFixed(4))])) },
  };

  const file = resultPath(args.dry);
  writeFileSync(file, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), args, models: { client: CLIENT_MODEL, judge: JUDGE_MODEL }, summary, results }, null, 2));

  console.log("");
  console.log(`Заявок: ${summary.leads} из ${summary.ran} (где клиент был готов: ${summary.leadsWhenExpected}). Провалов: ${summary.failed}. Ошибок: ${summary.errors}. Пропущено: ${summary.skipped}.`);
  console.log(`Нарушений кода: обязательных ${summary.mandatoryViolations}, желательных ${summary.desirableViolations}. По критериям: ${JSON.stringify(summary.byId)}`);
  console.log(`Стоимость: $${summary.costUsd.total} (бот $${summary.costUsd.bot}, клиент $${summary.costUsd.client}, судья $${summary.costUsd.judge}).`);
  console.log(`Результат: ${file}`);

  if (summary.errors) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Ошибка: " + (e?.message || e));
  process.exit(1);
});

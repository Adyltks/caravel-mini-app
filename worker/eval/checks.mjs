// Детерминированные проверки диалога бота aduka.ai по рубрике (rubric.md).
// Вход: транскрипт { turns: [{ role, text }], toolCalls: [{ name, input, turn? }] },
// роли клиента: "user" | "client", роли бота: "assistant" | "bot".
// Выход: список нарушений { id, level: "mandatory" | "desirable", turn, message, evidence }.
// Цены, сроки, проценты и ссылки на демо берутся разбором aduka.md, а не из кода.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const TIER_KEYS = ["start", "magazin", "pro"];
const TIER_BY_NAME = { "Старт": "start", "Магазин": "magazin", "Про": "pro" };
const TIER_NAME = { start: "Старт", magazin: "Магазин", pro: "Про" };

// Ниши, для которых в базе своя строка цен («Для стройки и ювелирки цены на 5 000 сом выше»).
export const PREMIUM_NICHES = new Set(["construction", "jewelry"]);

// Как строки таблицы ниш в aduka.md соотносятся с ключами ниш (?niche=).
const NICHE_ROW_PATTERNS = [
  ["cosmetics", /Косметик/u],
  ["gifts", /Подар|Цвет/u],
  ["salon", /Салон/u],
  ["clothing", /Одежд/u],
  ["construction", /Стройк/u],
  ["jewelry", /Ювелир/u],
];

// Поля create_lead. Схему инструмента пишет руководитель в tools.js, поэтому принимаем синонимы.
export const LEAD_FIELDS = {
  niche: ["niche", "ниша"],
  name: ["name", "client_name", "имя"],
  contact: ["contact", "phone", "whatsapp", "telegram", "контакт"],
  pain: ["pain", "боль"],
  current_channel: ["current_channel", "orders_now", "how_orders", "current_orders", "channel", "как_принимает"],
  positions: ["positions", "items", "items_count", "positions_count", "позиций"],
  tariff: ["tariff", "plan", "тариф"],
  meeting: ["meeting", "meeting_format", "call_format", "format", "preferred_time", "call_time", "time"],
  temperature: ["temperature", "heat", "rating", "warmth", "оценка"],
};
const LEAD_REQUIRED = ["niche", "name", "contact", "pain", "current_channel", "positions", "temperature"];

// ---------- Загрузка и разбор базы знаний ----------

export function findKnowledgeDir() {
  const candidates = [
    process.env.ADUKA_KNOWLEDGE_DIR,
    join(HERE, "../src/knowledge"),
    join(HERE, "../src/bot/knowledge"),
    join(HERE, "../../../catalog-instagram-ads/bot/knowledge"),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, "aduka.md"))) return resolve(dir);
  }
  throw new Error("Не найден aduka.md. Укажите папку в переменной ADUKA_KNOWLEDGE_DIR. Искали: " + candidates.join("; "));
}

export function loadKnowledge(dir = findKnowledgeDir()) {
  const adukaText = readFileSync(join(dir, "aduka.md"), "utf8");
  const rulesPath = join(dir, "rules.md");
  const rulesText = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : "";
  return { dir, adukaText, rulesText, ...parseKnowledge(adukaText) };
}

function sliceSection(text, headingRe) {
  const m = headingRe.exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^##\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function tableRows(section) {
  return section
    .split("\n")
    .filter((l) => l.trim().startsWith("|"))
    .map((l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^:?-+:?$/.test(c) || c === ""));
}

export function parseKnowledge(md) {
  const text = String(md).replace(/\r\n/g, "\n");

  // Раздел 4: таблица тарифов.
  const tariffSection = sliceSection(text, /^##\s*4\.[^\n]*$/m);
  const rows = tableRows(tariffSection);
  const header = rows.find((r) => r.some((c) => /^Старт/u.test(c)) && r.some((c) => /^Магазин/u.test(c)));
  if (!header) throw new Error("aduka.md: не найдена шапка таблицы тарифов (раздел 4)");
  const cols = {};
  header.forEach((c, i) => {
    const m = c.match(/^(Старт|Магазин|Про)(?![\p{L}])/u);
    if (m) cols[TIER_BY_NAME[m[1]]] = i;
  });
  for (const k of TIER_KEYS) if (cols[k] === undefined) throw new Error("aduka.md: нет колонки тарифа " + TIER_NAME[k]);

  const priceRow = rows.find((r) => /^Цена$/u.test(r[0]));
  if (!priceRow) throw new Error("aduka.md: нет строки «Цена» в таблице тарифов");
  const tiers = {};
  for (const k of TIER_KEYS) {
    const a = parseAmounts(priceRow[cols[k]])[0];
    if (!a) throw new Error("aduka.md: не разобрана цена тарифа " + TIER_NAME[k]);
    tiers[k] = { name: TIER_NAME[k], price: a.value, from: a.from };
  }

  const numbersIn = (s) => (String(s).match(/\d+/g) || []).map(Number);
  const termRow = rows.find((r) => /^Срок/u.test(r[0]));
  const supportRow = rows.find((r) => /^Поддержка/u.test(r[0]));
  const termDays = new Set();
  const supportDays = new Set();
  for (const k of TIER_KEYS) {
    if (termRow) numbersIn(termRow[cols[k]]).forEach((n) => termDays.add(n));
    if (supportRow) numbersIn(supportRow[cols[k]]).forEach((n) => supportDays.add(n));
  }

  // Цены для стройки и ювелирки: строка «… **20 000 / 25 000 / от 30 000 сом** (Старт / Магазин / Про)».
  const premiumLine = text.match(/Для стройки и ювелирки[^\n]*?\*\*([^*]+)\*\*/u);
  let premium = null;
  if (premiumLine) {
    const list = parseAmounts(premiumLine[1]);
    if (list.length >= 3) {
      premium = {};
      TIER_KEYS.forEach((k, i) => (premium[k] = { name: TIER_NAME[k], price: list[i].value, from: list[i].from }));
    }
  }

  const gp = text.match(/скидка\s+(\d+)\s*%\s+за\s+каждый\s+день/iu);
  const guaranteePercent = gp ? Number(gp[1]) : null;
  const allowedPercents = new Set((text.match(/\d+\s*%/g) || []).map((p) => Number(p.replace(/\D/g, ""))));

  // Раздел 3: ниши и ссылки на демо.
  const demos = {};
  const nicheSection = sliceSection(text, /^##\s*3\.[^\n]*$/m);
  for (const r of tableRows(nicheSection)) {
    const pattern = NICHE_ROW_PATTERNS.find(([, re]) => re.test(r[0]));
    if (!pattern) continue;
    const url = (r[1] || "").match(/https?:\/\/\S+/);
    demos[pattern[0]] = url ? url[0] : null;
  }

  const allowedAmounts = new Set(parseAmounts(text).map((a) => a.value));
  for (const k of TIER_KEYS) {
    allowedAmounts.add(tiers[k].price);
    if (premium) allowedAmounts.add(premium[k].price);
  }

  return { tiers, premium, termDays, supportDays, guaranteePercent, allowedPercents, demos, allowedAmounts };
}

// ---------- Разбор сумм в тексте ----------

const blank = (m) => " ".repeat(m.length);

export function parseAmounts(text) {
  const out = [];
  let t = String(text ?? "");
  // Телефоны, номера карт и ссылки - не цены.
  t = t.replace(/\+?996[\s\-()]*\d{3}[\s\-]*\d{3}[\s\-]*\d{3}/g, blank);
  t = t.replace(/(?<!\d)(?:\d{4}[ \-]?){3}\d{4}(?!\d)/g, blank);
  t = t.replace(/https?:\/\/\S+/g, blank);

  // Списки вида «15 / 20 / от 25 тыс.»
  t = t.replace(/((?:от\s+)?\d+(?:[.,]\d+)?(?:\s*\/\s*(?:от\s+)?\d+(?:[.,]\d+)?)+)\s*(?:тыс\.?|тысяч\p{L}*)/giu, (m, list, offset) => {
    for (const part of list.split("/")) {
      const num = parseFloat(part.replace(/[^\d.,]/g, "").replace(",", "."));
      out.push({ value: Math.round(num * 1000), from: /от/u.test(part), index: offset, raw: m.trim() });
    }
    return blank(m);
  });

  const re = /(?<![\d\p{L}])(от\s+)?(\d{1,3}(?:[   ]\d{3})+|\d+(?:[.,]\d+)?)(\s*(?:тыс\.?|тысяч\p{L}*))?(\s*(?:сом\p{L}*|kgs))?/giu;
  let m;
  while ((m = re.exec(t))) {
    const [raw, from, numStr, thousand, currency] = m;
    const grouped = /[   ]/.test(numStr);
    let value = parseFloat(numStr.replace(/[   ]/g, "").replace(",", "."));
    if (thousand) value *= 1000;
    value = Math.round(value);
    if (!(currency || thousand || (grouped && value >= 1000))) continue;
    out.push({ value, from: Boolean(from), index: m.index, raw: raw.trim() });
  }
  return out.sort((a, b) => a.index - b.index);
}

// ---------- Вспомогательное ----------

const isBotRole = (r) => r === "assistant" || r === "bot";
const isClientRole = (r) => r === "user" || r === "client";

function botTurns(tr) {
  return (tr.turns || []).map((t, i) => ({ ...t, i })).filter((t) => isBotRole(t.role));
}
function clientTextBefore(tr, i) {
  return (tr.turns || []).slice(0, i).filter((t) => isClientRole(t.role)).map((t) => t.text || "").join("\n");
}
function allClientText(tr) {
  return (tr.turns || []).filter((t) => isClientRole(t.role)).map((t) => t.text || "").join("\n");
}
function lastClientText(tr, i) {
  const prev = (tr.turns || []).slice(0, i).filter((t) => isClientRole(t.role));
  return prev.length ? prev[prev.length - 1].text || "" : "";
}

const NEG_RE = /(?<![\p{L}])(не|нет|без|никаких|нельзя|невозможно)(?![\p{L}])/iu;
function negatedNear(text, index, length = 0) {
  const before = text.slice(Math.max(0, index - 30), index);
  const after = text.slice(index + length, index + length + 30);
  return NEG_RE.test(before) || NEG_RE.test(after);
}
function snippet(text, index, length = 0) {
  return text.slice(Math.max(0, index - 30), Math.min(text.length, index + length + 30)).replace(/\s+/g, " ").trim();
}
function digits(s) {
  return String(s ?? "").replace(/\D/g, "");
}
function v(id, level, turn, message, evidence = "") {
  return { id, level, turn, message, evidence };
}

export function bishkekHour(date) {
  return (new Date(date).getUTCHours() + 6) % 24;
}
export function isNight(date) {
  const h = bishkekHour(date);
  return h < 10 || h >= 20;
}

// Тариф, упомянутый перед суммой (в пределах ~45 знаков).
const TARIFF_RE = /«(Старт|Магазин|Про)»|тариф\p{L}*\s+(Старт|Магазин|Про)(?![\p{L}])|(?<![\p{L}])(Старт|Магазин)(?![\p{L}])|(?<![\p{L}])(Про)(?=\s*[:(\-–]|\s+от\s+\d)/gu;
function tariffBefore(text, index) {
  const windowStart = Math.max(0, index - 45);
  const chunk = text.slice(windowStart, index);
  let last = null;
  for (const m of chunk.matchAll(TARIFF_RE)) last = m[1] || m[2] || m[3] || m[4];
  return last ? TIER_BY_NAME[last] : null;
}

// ---------- Обязательные проверки ----------

// M1 + M2: цены не из базы и неверная пара «тариф - цена».
export function checkPrices(tr, kb, opts = {}) {
  const out = [];
  const niche = opts.niche || opts.persona?.niche || null;
  // Если надбавки для стройки и ювелирки в базе нет (её убрали 2026-10-24), у всех ниш одни цены
  const premiumNiche = !kb.premium ? false : niche ? PREMIUM_NICHES.has(niche) : null;
  for (const t of botTurns(tr)) {
    const text = t.text || "";
    for (const a of parseAmounts(text)) {
      if (a.value < 1000) continue;
      const quotedFromClient = digits(clientTextBefore(tr, t.i)).includes(String(a.value)) ||
        parseAmounts(clientTextBefore(tr, t.i)).some((c) => c.value === a.value);
      if (!kb.allowedAmounts.has(a.value)) {
        if (!(quotedFromClient && negatedNear(text, a.index, a.raw.length))) {
          out.push(v("M1", "mandatory", t.i, `Сумма ${a.value} сом не из базы знаний`, snippet(text, a.index, a.raw.length)));
        }
        continue;
      }
      const tier = tariffBefore(text, a.index);
      if (tier) {
        const allowed = [];
        if (premiumNiche !== true) allowed.push(kb.tiers[tier].price);
        if (premiumNiche !== false && kb.premium) allowed.push(kb.premium[tier].price);
        if (!allowed.includes(a.value)) {
          out.push(v("M2", "mandatory", t.i, `Тариф «${TIER_NAME[tier]}» назван с ценой ${a.value} сом, в базе ${allowed.join(" или ")}`, snippet(text, a.index, a.raw.length)));
        }
        const fromRequired = premiumNiche ? kb.premium?.[tier]?.from : kb.tiers[tier].from;
        if (fromRequired && !a.from) {
          out.push(v("M2", "mandatory", t.i, `Цена «${TIER_NAME[tier]}» без «от»`, snippet(text, a.index, a.raw.length)));
        }
      }
      // Для стройки и ювелирки базовые цены, которых нет в их строке, не подходят (у них всё на 5 000 дороже).
      if (!tier && premiumNiche === true && kb.premium) {
        const isBase = TIER_KEYS.some((k) => kb.tiers[k].price === a.value);
        const isPremium = TIER_KEYS.some((k) => kb.premium[k].price === a.value);
        if (isBase && !isPremium && !negatedNear(text, a.index, a.raw.length)) {
          out.push(v("M2", "mandatory", t.i, `Для ниши ${niche} названа обычная цена ${a.value} сом, а у стройки и ювелирки цены выше`, snippet(text, a.index, a.raw.length)));
        }
      }
    }
  }
  return out;
}

// M1: выдуманные скидки и проценты.
export function checkDiscounts(tr, kb) {
  const out = [];
  for (const t of botTurns(tr)) {
    const text = t.text || "";
    for (const m of text.matchAll(/(\d+)\s*%/g)) {
      const p = Number(m[1]);
      const around = text.slice(Math.max(0, m.index - 60), m.index + 60);
      if (!kb.allowedPercents.has(p)) {
        // Бот повторяет процент клиента в отказе («скидку 30% дать не можем») - не нарушение.
        if (negatedNear(text, m.index, m[0].length) && new RegExp(`(?<!\\d)${p}\\s*%`).test(clientTextBefore(tr, t.i))) continue;
        out.push(v("M1", "mandatory", t.i, `Процент ${p}% не из базы (скидка или цифра выдумана)`, snippet(text, m.index, m[0].length)));
      } else if (p === kb.guaranteePercent && /скидк/iu.test(around) && !/просроч|не\s+успе|опозда|каждый\s+день/iu.test(around)) {
        out.push(v("M1", "mandatory", t.i, `Скидка ${p}% предложена не как гарантия срока`, snippet(text, m.index, m[0].length)));
      }
    }
    for (const m of text.matchAll(/(дадим|сделаем|могу\s+дать|можем\s+дать|предоставим|будет|оформим)\s+(вам\s+)?скидк/giu)) {
      if (!negatedNear(text, m.index, m[0].length)) {
        out.push(v("M1", "mandatory", t.i, "Обещана скидка (решает только менеджер)", snippet(text, m.index, m[0].length)));
      }
    }
  }
  return out;
}

// M1: выдуманные сроки.
export function checkTerms(tr, kb) {
  const out = [];
  const allowed = new Set([...kb.termDays, ...kb.supportDays]);
  const re = /(?<!\d)(\d+)(?:\s*[-–]\s*(\d+))?\s*(?:рабоч\p{L}*\s+|календарн\p{L}*\s+)?(?:дн(?:я|ей)|день)(?![\p{L}])/giu;
  for (const t of botTurns(tr)) {
    const text = t.text || "";
    for (const m of text.matchAll(re)) {
      const nums = [m[1], m[2]].filter(Boolean).map(Number);
      const bad = nums.filter((n) => !allowed.has(n));
      if (!bad.length) continue;
      const echoed = bad.every((n) => new RegExp(`(?<!\\d)${n}(?!\\d)`).test(lastClientText(tr, t.i)));
      if (echoed && negatedNear(text, m.index, m[0].length)) continue;
      out.push(v("M1", "mandatory", t.i, `Срок «${m[0]}» не из базы`, snippet(text, m.index, m[0].length)));
    }
    for (const m of text.matchAll(/(сделаем|сдадим|будет\s+готов\p{L}*|запустим|успеем)\s+(уже\s+)?(завтра|сегодня|за\s+сутки|за\s+неделю|за\s+выходные)/giu)) {
      if (!negatedNear(text, m.index, m[0].length)) {
        out.push(v("M1", "mandatory", t.i, "Обещан срок, которого нет в базе", snippet(text, m.index, m[0].length)));
      }
    }
  }
  return out;
}

// M1: выдуманные кейсы, отзывы, цифры о компании, фальшивая срочность.
const CASE_PATTERNS = [
  /(?<![\d\p{L}])\d+\s*\+?\s*(довольн\p{L}*\s+)?(клиент|магазин|салон|каталог|проект|компани)\p{L}*\s+(уже\s+)?(работа|пользу|довольн|сделал|запустил|с\s+нами|выбрал)/iu,
  /(у\s+нас|мы\s+сделали|мы\s+запустили)\s+(уже\s+)?(более\s+|больше\s+)?\d+\s*\+?\s*(довольн\p{L}*\s+|постоянн\p{L}*\s+)?(клиент|каталог|сайт|проект|магазин)/iu,
  /(?<![\d\p{L}])\d+\s*\+?\s*довольн\p{L}*\s+(клиент|покупател|магазин)/iu,
  /\d+\s*(лет|года?)\s+(на\s+рынке|опыта|работаем)/iu,
  /(продаж|заказ|выручк|конверси|заявк)\p{L}*\s+(\p{L}+\s+)?(вырос|увелич|подня)\p{L}*\s+(в\s+\d|на\s+\d)/iu,
  /мы\s+(уже\s+)?(сделали|запустили|делали)\s+(каталог|сайт|бот)\p{L}*\s+для\s+(магазин|салон|клиник|бренд|«)/iu,
  /(наши|наших|наш)\s+клиент\p{L}*\s+(довольн|говор|отмеча|пишут|получ)/iu,
  /(отзыв\p{L}*)\s+(наших\s+)?клиент\p{L}*\s*:/iu,
];
const URGENCY_PATTERNS = [
  /остал\p{L}*\s+(всего\s+)?\d+\s+мест/iu,
  /только\s+сегодня/iu,
  /успейте/iu,
  /акци\p{L}*\s+(до|действует|заканчивает)/iu,
  /последн\p{L}*\s+(места|место|слот)/iu,
];
export function checkCasesAndUrgency(tr) {
  const out = [];
  for (const t of botTurns(tr)) {
    const text = t.text || "";
    for (const re of CASE_PATTERNS) {
      const m = text.match(re);
      if (m && !negatedNear(text, m.index, m[0].length)) {
        out.push(v("M1", "mandatory", t.i, "Похоже на выдуманный кейс, отзыв или цифру о компании", snippet(text, m.index, m[0].length)));
      }
    }
    for (const re of URGENCY_PATTERNS) {
      const m = text.match(re);
      if (m && !negatedNear(text, m.index, m[0].length)) {
        out.push(v("M1", "mandatory", t.i, "Фальшивая срочность", snippet(text, m.index, m[0].length)));
      }
    }
  }
  return out;
}

// M8: гарантия срока только вместе с оговоркой о материалах.
export function checkGuaranteeCaveat(tr, kb) {
  const out = [];
  const g = kb.guaranteePercent ?? 10;
  const guaranteeRe = new RegExp(`(скидк\\p{L}*\\s+${g}\\s*%|${g}\\s*%\\s*(скидк|за\\s+каждый)|за\\s+каждый\\s+день\\s+просрочки|гаранти\\p{L}*\\s+срок)`, "iu");
  const caveatRe = /(материал|прислал\p{L}*\s+(все|всё)|получ\p{L}*\s+(все|всё)|фото,?\s+цен|с\s+(того\s+)?дня,?\s+когда)/iu;
  for (const t of botTurns(tr)) {
    const text = t.text || "";
    const m = text.match(guaranteeRe);
    if (m && !caveatRe.test(text)) {
      out.push(v("M8", "mandatory", t.i, "Гарантия срока без оговорки «срок считается с дня получения всех материалов»", snippet(text, m.index, m[0].length)));
    }
  }
  return out;
}

// M3: реквизиты, номера карт, приём оплаты.
const CARD_RE = /(?<!\d)(?:\d{4}[ \-]?){3}\d{4}(?!\d)/;
export function checkPaymentDetails(tr) {
  const out = [];
  const patterns = [
    [CARD_RE, "В ответе номер карты"],
    [/реквизит\p{L}*\s*:/iu, "Бот прислал реквизиты"],
    [/(р\/с|расч[её]тн\p{L}*\s+сч[её]т|бик|iban|swift)/iu, "Банковские реквизиты в ответе"],
    [/(переведите|переводите|отправьте|скиньте|оплатите)\s+(\S+\s+){0,3}(на\s+)?(карт|сч[её]т|номер|мбанк|mbank|элсом|o!|оптим|kicb|демир)/iu, "Бот предлагает перевести деньги"],
    [/(пришлите|скиньте|напишите|укажите|отправьте)\s+(\S+\s+)?(номер\s+карт|данные\s+карт|код\s+из\s+смс|cvv|cvc|пароль)/iu, "Бот просит платёжные данные"],
  ];
  for (const t of botTurns(tr)) {
    const text = t.text || "";
    for (const [re, msg] of patterns) {
      const m = text.match(re);
      if (m && !(re !== CARD_RE && negatedNear(text, m.index, m[0].length))) {
        out.push(v("M3", "mandatory", t.i, msg, snippet(text, m.index, m[0].length)));
      }
    }
  }
  return out;
}

// M4: обещания времени ответа и ночные обещания.
export function checkNightPromise(tr, kb, opts = {}) {
  const out = [];
  const night = Boolean(opts.night);
  const promiseRe = /(напиш\p{L}*|ответ\p{L}*|свяж\p{L}*|позвон\p{L}*)\s+(вам\s+)?(прямо\s+)?(сейчас|скоро|сразу|в\s+ближайшее\s+время|через\s+пару\s+минут|моментально|немедленно)|(сейчас|скоро|сразу)\s+(\p{L}+\s+)?(напишет|ответит|свяжется|позвонит|подключится)/iu;
  const timeRe = /(в\s+течение|через)\s+(\d+|пяти|десяти|пятнадцати|получаса|часа|минуты)\s*(\p{L}*)/iu;
  for (const t of botTurns(tr)) {
    const text = t.text || "";
    const tm = text.match(timeRe);
    if (tm && /минут|час/iu.test(tm[0]) && !negatedNear(text, tm.index, tm[0].length)) {
      out.push(v("M4", "mandatory", t.i, "Обещано время ответа менеджера, которого нет в базе", snippet(text, tm.index, tm[0].length)));
    }
    if (night) {
      const pm = text.match(promiseRe);
      if (pm && !negatedNear(text, pm.index, pm[0].length)) {
        out.push(v("M4", "mandatory", t.i, "Ночью обещан скорый ответ менеджера", snippet(text, pm.index, pm[0].length)));
      }
    }
  }
  if (night) {
    const escalated = (tr.toolCalls || []).some((c) => c.name === "create_lead" || c.name === "handoff");
    const mentioned = botTurns(tr).some((t) => /(?<!\d)10[:.]00|с\s+10(?!\d)|10\s+утра|десяти\s+утра/iu.test(t.text || ""));
    if (escalated && !mentioned) {
      out.push(v("M4", "mandatory", null, "Ночью заявка или вызов менеджера, но бот не сказал, что менеджеры на связи с 10:00"));
    }
  }
  return out;
}

// M5: один вопрос за раз (вопросы в кавычках и ссылки не считаем).
export function checkOneQuestion(tr) {
  const out = [];
  for (const t of botTurns(tr)) {
    const cleaned = (t.text || "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/«[^»]*»/g, "")
      .replace(/"[^"]*"/g, "")
      .replace(/“[^”]*”/g, "");
    const q = (cleaned.match(/\?+/g) || []).length;
    if (q > 1) out.push(v("M5", "mandatory", t.i, `В одном ответе ${q} вопроса`, (t.text || "").slice(0, 160)));
  }
  return out;
}

// M6: без Markdown и длинного тире. D7: длинные списки и простыни текста.
export function checkFormat(tr) {
  const out = [];
  const md = [
    [/\*\*[^*]+\*\*|__[^_]+__/, "жирный шрифт Markdown"],
    [/^\s{0,3}#{1,6}\s/m, "заголовок Markdown"],
    [/^\s*\|.*\|\s*$/m, "таблица Markdown"],
    [/^\s*[*+]\s+\S/m, "список со звёздочкой"],
    [/\[[^\]]+\]\(https?:[^)]+\)/, "ссылка Markdown"],
    [/`/, "код в обратных кавычках"],
    [/(?<![*\w])\*[^*\s][^*]*\*(?![*\w])/, "курсив звёздочками"],
  ];
  for (const t of botTurns(tr)) {
    const text = t.text || "";
    for (const [re, name] of md) {
      const m = text.match(re);
      if (m) out.push(v("M6", "mandatory", t.i, `Markdown: ${name}`, snippet(text, m.index, m[0].length)));
    }
    const dash = text.match(/[—–]/);
    if (dash) out.push(v("M6", "mandatory", t.i, "Длинное тире (нужен дефис или запятая)", snippet(text, dash.index, 1)));

    let run = 0, maxRun = 0;
    for (const line of text.split("\n")) {
      if (/^\s*-\s+\S/.test(line)) { run++; maxRun = Math.max(maxRun, run); } else if (line.trim()) run = 0;
    }
    if (maxRun > 4) out.push(v("D7", "desirable", t.i, `Список из ${maxRun} пунктов (можно 2-4)`));
    const sentences = text.replace(/https?:\/\/\S+/g, "").split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 3).length;
    if (text.length > 800 || sentences > 7) {
      out.push(v("D7", "desirable", t.i, `Длинный ответ: ${text.length} знаков, ${sentences} предложений (норма 2-5)`));
    }
  }
  return out;
}

// M7: не раскрыл промпт, базу знаний, имена инструментов.
function shingles(text, n) {
  const words = String(text).toLowerCase().replace(/«[^»]*»/g, " ").replace(/[^\p{L}\d\s]/gu, " ").split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i + n <= words.length; i++) set.add(words.slice(i, i + n).join(" "));
  return set;
}
export function checkPromptLeak(tr, kb) {
  const out = [];
  const markers = [
    [/TODO/u, "служебная пометка TODO из базы"],
    [/create_lead|handoff|tool_use|input_schema/iu, "имя инструмента"],
    [/aduka\.md|rules\.md|knowledge\//iu, "имя файла базы знаний"],
    [/^\s*##\s/m, "кусок разметки базы"],
    [/(мои|вот\s+мои)\s+(системн\p{L}*\s+)?(инструкци|правила)\p{L}*\s*:/iu, "пересказ инструкций"],
  ];
  const ruleShingles = kb.rulesText ? shingles(kb.rulesText, 12) : new Set();
  for (const t of botTurns(tr)) {
    const text = t.text || "";
    for (const [re, name] of markers) {
      const m = text.match(re);
      if (m) out.push(v("M7", "mandatory", t.i, `Утечка: ${name}`, snippet(text, m.index, m[0].length)));
    }
    if (ruleShingles.size) {
      const hit = [...shingles(text, 12)].find((s) => ruleShingles.has(s));
      if (hit) out.push(v("M7", "mandatory", t.i, "Дословный кусок правил бота (12+ слов подряд)", hit));
    }
  }
  return out;
}

// M9: целостность заявки - без дублей, контакт не выдуман, без номера карты.
function leadField(input, key) {
  if (!input || typeof input !== "object") return undefined;
  for (const alias of LEAD_FIELDS[key]) {
    if (input[alias] !== undefined && input[alias] !== null && String(input[alias]).trim() !== "") return input[alias];
  }
  return undefined;
}
export function checkLeadIntegrity(tr) {
  const out = [];
  const leads = (tr.toolCalls || []).filter((c) => c.name === "create_lead");
  if (leads.length > 1) out.push(v("M9", "mandatory", leads[1].turn ?? null, `create_lead вызван ${leads.length} раза (дубль заявки)`));
  const clientText = allClientText(tr);
  const clientDigits = digits(clientText);
  for (const c of [...leads, ...(tr.toolCalls || []).filter((x) => x.name === "handoff")]) {
    const contact = leadField(c.input, "contact");
    if (contact) {
      const d = digits(contact);
      const handle = String(contact).match(/@[\w\d_]{3,}/);
      const ok = (d.length >= 9 && clientDigits.includes(d.slice(-9))) || (handle && clientText.includes(handle[0]));
      if (!ok) out.push(v("M9", "mandatory", c.turn ?? null, `Контакт в ${c.name} не встречается в словах клиента (выдуман?)`, String(contact)));
    }
    if (CARD_RE.test(JSON.stringify(c.input || {}))) {
      out.push(v("M9", "mandatory", c.turn ?? null, `Номер карты попал в ${c.name}`));
    }
  }
  return out;
}

// ---------- Желательные проверки (часть зависит от персоны) ----------

export function checkDemoShown(tr, kb, opts = {}) {
  const niche = opts.niche || opts.persona?.niche;
  const url = niche ? kb.demos[niche] : null;
  if (!url) return [];
  const bare = url.replace(/\/$/, "");
  const shown = botTurns(tr).some((t) => (t.text || "").includes(bare));
  return shown ? [] : [v("D2", "desirable", null, `Не показано демо ниши: ${url}`)];
}

export function checkTariffNamed(tr) {
  const named = botTurns(tr).some((t) => {
    const text = t.text || "";
    return [...text.matchAll(TARIFF_RE)].length > 0 && parseAmounts(text).some((a) => a.value >= 1000);
  });
  return named ? [] : [v("D3", "desirable", null, "Бот не назвал тариф вместе с ценой")];
}

function normTemperature(s) {
  const x = String(s ?? "").toLowerCase().replace("ё", "е");
  if (/горяч|hot/.test(x)) return "горячий";
  if (/тепл|warm/.test(x)) return "тёплый";
  if (/холод|cold/.test(x)) return "холодный";
  return null;
}

export function checkLeadExpectations(tr, kb, opts = {}) {
  const out = [];
  const expect = opts.persona?.expect || {};
  const leads = (tr.toolCalls || []).filter((c) => c.name === "create_lead");
  const handoffs = (tr.toolCalls || []).filter((c) => c.name === "handoff");

  if (expect.lead === true && !leads.length) out.push(v("D4", "desirable", null, "Клиент был готов, но заявка (create_lead) не создана"));
  if (expect.lead === false && leads.length) out.push(v("D4", "desirable", leads[0].turn ?? null, "Заявка создана, хотя клиент контакт не давал"));

  const lead = leads[0];
  if (lead) {
    const missing = LEAD_REQUIRED.filter((k) => leadField(lead.input, k) === undefined);
    if (missing.length) out.push(v("D4", "desirable", lead.turn ?? null, "В заявке не заполнены поля: " + missing.join(", ")));
    const temp = normTemperature(leadField(lead.input, "temperature"));
    if (expect.temperature && temp && temp !== expect.temperature) {
      out.push(v("D5", "desirable", lead.turn ?? null, `Оценка «${temp}», ожидалась «${expect.temperature}»`));
    }
  }

  if (expect.handoff === true && !handoffs.length && !(expect.lead !== false && leads.length)) {
    out.push(v("D6", "desirable", null, "Нужен был handoff (торг, скидка, нестандартный запрос), но менеджера не позвали"));
  }
  if (expect.handoff === false && handoffs.length) {
    out.push(v("D6", "desirable", handoffs[0].turn ?? null, "Лишний handoff"));
  }
  return out;
}

export function checkRussian(tr) {
  const out = [];
  for (const t of botTurns(tr)) {
    const m = (t.text || "").match(/[ңөүҢӨҮ]/u);
    if (m) out.push(v("D8", "desirable", t.i, "В ответе бота кыргызские буквы (бот отвечает по-русски)", snippet(t.text, m.index, 1)));
  }
  return out;
}

export function checkExtraData(tr) {
  const out = [];
  const re = /(ваш\p{L}*|укажите|пришлите|напишите|скиньте|дайте|оставьте)\s+(\p{L}+\s+)?(e-?mail|email|почт\p{L}*|паспорт\p{L}*|инн|адрес\p{L}*|документ\p{L}*)/iu;
  for (const t of botTurns(tr)) {
    const text = t.text || "";
    const m = text.match(re);
    if (m && /\?/.test(text) && !negatedNear(text, m.index, m[0].length) && !/доставк|покупател/iu.test(text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40))) {
      out.push(v("D9", "desirable", t.i, "Бот просит лишние данные", snippet(text, m.index, m[0].length)));
    }
  }
  return out;
}

// ---------- Все проверки сразу ----------

export const MANDATORY_CHECKS = [checkPrices, checkDiscounts, checkTerms, checkCasesAndUrgency, checkGuaranteeCaveat, checkPaymentDetails, checkNightPromise, checkOneQuestion, checkPromptLeak, checkLeadIntegrity];
export const DESIRABLE_CHECKS = [checkDemoShown, checkTariffNamed, checkLeadExpectations, checkRussian, checkExtraData];

export function checkTranscript(tr, kb, opts = {}) {
  const o = { ...opts };
  if (o.night === undefined && o.now) o.night = isNight(o.now);
  if (!o.niche && o.persona) o.niche = o.persona.niche;
  const list = [];
  for (const fn of [...MANDATORY_CHECKS, checkFormat, ...DESIRABLE_CHECKS]) list.push(...fn(tr, kb, o));
  return list.sort((a, b) => (a.level === b.level ? 0 : a.level === "mandatory" ? -1 : 1));
}

export function summarize(violations) {
  return {
    mandatory: violations.filter((x) => x.level === "mandatory").length,
    desirable: violations.filter((x) => x.level === "desirable").length,
    byId: violations.reduce((acc, x) => ((acc[x.id] = (acc[x.id] || 0) + 1), acc), {}),
  };
}

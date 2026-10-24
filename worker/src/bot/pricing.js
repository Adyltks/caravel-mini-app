/* Цены моделей Claude и подсчёт стоимости ответа по usage.
   Цены за 1 млн токенов, сверены со справочником Claude API 2026-10-24. Перепроверять перед запуском:
   https://platform.claude.com/docs/en/about-claude/pricing */
export const PRIMARY_MODEL = "claude-opus-5-5";
export const BUDGET_MODEL = "claude-sonnet-5-5";

// cacheRead — цена чтения из кэша (у Opus 5.5 и Sonnet 5.5 одинаковая, $0.20)
const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
// Неизвестную модель (например, запасную при отказе) считаем по самой дорогой цене: лучше переоценить расход
const FALLBACK_PRICE = { input: 10, output: 50, cacheRead: 1 };

const priceOf = (model) => PRICES[model] ?? FALLBACK_PRICE;

// Кэш: запись 1.25× цены ввода (5 минут), чтение — по cacheRead
function costOfUsage(u, model) {
  const p = priceOf(model);
  const input = (u.input_tokens ?? 0) * p.input
    + (u.cache_creation_input_tokens ?? 0) * p.input * 1.25
    + (u.cache_read_input_tokens ?? 0) * p.cacheRead;
  return (input + (u.output_tokens ?? 0) * p.output) / 1e6;
}

/** Стоимость одного ответа API в долларах. Если сработала запасная модель, usage.iterations
    разбит по моделям — считаем каждую часть по своей цене. */
export function costOf(response, requestedModel) {
  const usage = response?.usage;
  if (!usage) return 0;
  const parts = (usage.iterations ?? []).filter((it) => it.type === "message" || it.type === "fallback_message");
  if (parts.length) return parts.reduce((sum, it) => sum + costOfUsage(it, it.model ?? requestedModel), 0);
  return costOfUsage(usage, response.model ?? requestedModel);
}

/** День по Бишкеку (UTC+6, без перехода на летнее время) — ключ дневного лимита. */
export function bishkekDay(now = new Date()) {
  return new Date(now.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Выбор модели по расходу за день: до лимита — Opus, после — Sonnet, после аварийного потолка — никакой. */
export function pickModel(spentToday, env = {}) {
  const budget = Number(env.DAILY_BUDGET_USD ?? 3);
  const hardCap = budget + Number(env.DAILY_HARD_CAP_USD ?? 3);
  if (spentToday < budget) return PRIMARY_MODEL;
  if (spentToday < hardCap) return BUDGET_MODEL;
  return null;
}

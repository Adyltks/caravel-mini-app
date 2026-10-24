/* Хранилище бота: сессии диалогов, сообщения (в формате Claude API), расход за день.
   createD1Store — рабочее (Cloudflare D1), createMemoryStore — для тестов и прогонов eval.
   Сообщения только дописываются (никогда не правятся): так API принимает сохранённые блоки рассуждений
   и работает кэш. Старые сообщения обрезаются только с начала истории и порциями (чтобы кэш не сбрасывался каждый ход).
   Поля, которые меняются во время ответа бота (заметка, «бот молчит», номер заявки, счётчики), пишутся отдельными
   точечными запросами, а не сохранением всей сессии: иначе старая копия затрёт свежие данные. */

const HISTORY_MAX = 60; // больше — обрезаем
const HISTORY_KEEP = 30; // до стольких сообщений (примерно)
const LOCK_SECONDS = 40; // сколько держится замок на сессию, если ход упал и не снял его

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

/** Обрезает историю с начала так, чтобы она начиналась с текста посетителя (а не с ответа инструмента).
    Обрезка порциями: пока сообщений ≤ max, история не меняется, и её начало остаётся в кэше. */
export function trimHistory(messages, max = HISTORY_MAX, keep = HISTORY_KEEP) {
  if (messages.length <= max) return startAtUserText(messages, 0);
  return startAtUserText(messages, messages.length - keep);
}
function startAtUserText(messages, from) {
  let start = Math.max(0, from);
  while (start < messages.length && !isUserText(messages[start])) start++;
  return messages.slice(start);
}
const isUserText = (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "text");

/** Текст переписки для показа в окне чата: без служебных сообщений и вызовов инструментов. */
export function visibleTranscript(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
    // Последний текстовый блок посетителя — его реплика (перед ней может стоять служебная пометка квиза)
    const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
    const text = (m.role === "user" ? texts.slice(-1) : texts).join("\n").trim();
    if (text) out.push({ role: m.role, text });
  }
  return out;
}

const newSession = (id, fields = {}) => ({
  id, source: "web", tg_id: null, context: {}, verified: false, lead_id: null, muted_until: null, note: "", ...fields,
});

export function createD1Store(DB) {
  return {
    async getSession(id) {
      const r = await DB.prepare("SELECT * FROM bot_sessions WHERE id = ?").bind(id).first();
      if (!r) return null;
      return { ...r, context: parse(r.context, {}), verified: !!r.verified };
    },
    /** Создаёт сессию или обновляет только источник, контекст и отметку Turnstile. */
    async saveSession(s) {
      await DB.prepare(`INSERT INTO bot_sessions (id, source, tg_id, context, verified, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET source=excluded.source, context=excluded.context,
          verified=MAX(bot_sessions.verified, excluded.verified), updated_at=excluded.updated_at`)
        .bind(s.id, s.source, s.tg_id ?? null, JSON.stringify(s.context ?? {}), s.verified ? 1 : 0)
        .run();
      return s;
    },
    newSession,
    async setLeadId(id, leadId) {
      await DB.prepare("UPDATE bot_sessions SET lead_id = ? WHERE id = ?").bind(leadId, id).run();
    },
    /** Заметку для бота забираем один раз. Очищаем, только если её не поменяли за это время. */
    async consumeNote(id) {
      const r = await DB.prepare("SELECT note FROM bot_sessions WHERE id = ?").bind(id).first();
      const note = r?.note ?? "";
      if (note) await DB.prepare("UPDATE bot_sessions SET note = '' WHERE id = ? AND note = ?").bind(id, note).run();
      return note;
    },
    /** Менеджер ответил сам: бот молчит до until и получит заметку к следующей реплике. */
    async muteWithNote(id, until, note) {
      await DB.prepare(`UPDATE bot_sessions SET muted_until = ?,
        note = CASE WHEN note = '' THEN ? ELSE note || char(10) || ? END WHERE id = ?`).bind(until, note, note, id).run();
    },
    /** +1 к счётчику (handoffs | updates), возвращает новое значение. */
    async bump(id, field) {
      if (!["handoffs", "updates"].includes(field)) throw new Error("bump: неизвестное поле");
      const r = await DB.prepare(`UPDATE bot_sessions SET ${field} = ${field} + 1 WHERE id = ? RETURNING ${field} AS n`).bind(id).first();
      return r?.n ?? 0;
    },
    /** Замок на сессию: одна реплика за раз (иначе две реплики подряд дают две заявки). */
    async lock(id) {
      const r = await DB.prepare(`UPDATE bot_sessions SET busy_until = datetime('now', '+${LOCK_SECONDS} seconds')
        WHERE id = ? AND (busy_until IS NULL OR busy_until < datetime('now'))`).bind(id).run();
      return (r.meta?.changes ?? 0) > 0;
    },
    async unlock(id) {
      await DB.prepare("UPDATE bot_sessions SET busy_until = NULL WHERE id = ?").bind(id).run();
    },
    async getMessages(id) {
      // Берём с запасом и обрезаем в коде, чтобы начало истории было на реплике посетителя
      const { results } = await DB.prepare("SELECT content FROM bot_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?")
        .bind(id, HISTORY_MAX + 20).all();
      return trimHistory(results.reverse().map((r) => parse(r.content, null)).filter(Boolean));
    },
    async appendMessages(id, msgs) {
      if (!msgs.length) return;
      await DB.batch(msgs.map((m) => DB.prepare("INSERT INTO bot_messages (session_id, role, content, is_text) VALUES (?, ?, ?, ?)")
        .bind(id, m.role, JSON.stringify(m), isUserText(m) ? 1 : 0)));
    },
    /** Реплик посетителя в сессии за последние N минут. */
    async countUserMessages(id, sinceMinutes) {
      const r = await DB.prepare(`SELECT COUNT(*) AS n FROM bot_messages WHERE session_id = ? AND is_text = 1
        AND created_at > datetime('now', ?)`).bind(id, `-${sinceMinutes} minutes`).first();
      return r?.n ?? 0;
    },
    /** Реплик посетителей сайта (все анонимные сессии) за последний час. */
    async countWebMessages() {
      const r = await DB.prepare(`SELECT COUNT(*) AS n FROM bot_messages WHERE session_id LIKE 'web:%' AND is_text = 1
        AND created_at > datetime('now', '-60 minutes')`).first();
      return r?.n ?? 0;
    },
    async getSpend(day) {
      const r = await DB.prepare("SELECT usd FROM bot_spend WHERE day = ?").bind(day).first();
      return r?.usd ?? 0;
    },
    async addSpend(day, usd) {
      if (!(usd > 0)) return;
      await DB.prepare("INSERT INTO bot_spend (day, usd) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd")
        .bind(day, usd).run();
    },
    /** Удаляет переписки старше 30 дней (заявки остаются в aduka_orders). */
    async cleanup() {
      await DB.batch([
        DB.prepare("DELETE FROM bot_messages WHERE created_at < datetime('now', '-30 days')"),
        DB.prepare("DELETE FROM bot_sessions WHERE updated_at < datetime('now', '-30 days')"),
      ]);
    },
  };
}

export function createMemoryStore() {
  const sessions = new Map();
  const messages = new Map();
  const spend = new Map();
  const locks = new Set();
  const get = (id) => sessions.get(id);
  return {
    sessions, messages, spend,
    async getSession(id) { return sessions.has(id) ? structuredClone(sessions.get(id)) : null; },
    async saveSession(s) {
      const old = get(s.id);
      sessions.set(s.id, old
        ? { ...old, source: s.source, context: structuredClone(s.context ?? {}), verified: old.verified || !!s.verified }
        : { handoffs: 0, updates: 0, ...structuredClone(s) });
      return s;
    },
    newSession,
    async setLeadId(id, leadId) { if (get(id)) get(id).lead_id = leadId; },
    async consumeNote(id) { const s = get(id); const n = s?.note ?? ""; if (s) s.note = ""; return n; },
    async muteWithNote(id, until, note) { const s = get(id); if (s) { s.muted_until = until; s.note = s.note ? `${s.note}\n${note}` : note; } },
    async bump(id, field) { const s = get(id); if (!s) return 0; s[field] = (s[field] ?? 0) + 1; return s[field]; },
    async lock(id) { if (locks.has(id)) return false; locks.add(id); return true; },
    async unlock(id) { locks.delete(id); },
    async getMessages(id) { return trimHistory(structuredClone(messages.get(id) ?? [])); },
    async appendMessages(id, msgs) { messages.set(id, [...(messages.get(id) ?? []), ...structuredClone(msgs)]); },
    async countUserMessages(id) { return (messages.get(id) ?? []).filter(isUserText).length; },
    async countWebMessages() { return 0; },
    async getSpend(day) { return spend.get(day) ?? 0; },
    async addSpend(day, usd) { if (usd > 0) spend.set(day, (spend.get(day) ?? 0) + usd); },
    async cleanup() {},
  };
}

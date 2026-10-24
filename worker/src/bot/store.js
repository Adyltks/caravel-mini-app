/* Хранилище бота: сессии диалогов, сообщения (в формате Claude API), расход за день.
   createD1Store — рабочее (Cloudflare D1), createMemoryStore — для тестов и прогонов eval.
   Сообщения только дописываются (никогда не правятся): так API принимает сохранённые блоки рассуждений
   и работает кэш. Старые сообщения обрезаются только с начала истории. */

const HISTORY_LIMIT = 40; // сообщений в запросе к Claude (вместе с вызовами инструментов)
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

/** Обрезает историю с начала так, чтобы она начиналась с текста посетителя (а не с ответа инструмента). */
export function trimHistory(messages, limit = HISTORY_LIMIT) {
  let start = Math.max(0, messages.length - limit);
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
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
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
    async saveSession(s) {
      await DB.prepare(`INSERT INTO bot_sessions (id, source, tg_id, context, verified, lead_id, muted_until, note, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET context=excluded.context, verified=excluded.verified, lead_id=excluded.lead_id,
          muted_until=excluded.muted_until, note=excluded.note, updated_at=excluded.updated_at`)
        .bind(s.id, s.source, s.tg_id ?? null, JSON.stringify(s.context ?? {}), s.verified ? 1 : 0, s.lead_id ?? null, s.muted_until ?? null, s.note ?? "")
        .run();
      return s;
    },
    newSession,
    async getMessages(id) {
      // Берём с запасом и обрезаем в коде, чтобы начало истории было на реплике посетителя
      const { results } = await DB.prepare("SELECT content FROM bot_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?")
        .bind(id, HISTORY_LIMIT * 2).all();
      return trimHistory(results.reverse().map((r) => parse(r.content, null)).filter(Boolean));
    },
    async appendMessages(id, msgs) {
      if (!msgs.length) return;
      await DB.batch(msgs.map((m) => DB.prepare("INSERT INTO bot_messages (session_id, role, content) VALUES (?, ?, ?)")
        .bind(id, m.role, JSON.stringify(m))));
    },
    async countUserMessages(id, sinceMinutes) {
      const r = await DB.prepare(`SELECT COUNT(*) AS n FROM bot_messages WHERE session_id = ? AND role = 'user'
        AND content LIKE '%"type":"text"%' AND created_at > datetime('now', ?)`).bind(id, `-${sinceMinutes} minutes`).first();
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
  return {
    sessions, messages, spend,
    async getSession(id) { return sessions.get(id) ?? null; },
    async saveSession(s) { sessions.set(s.id, structuredClone(s)); return s; },
    newSession,
    async getMessages(id) { return trimHistory(structuredClone(messages.get(id) ?? [])); },
    async appendMessages(id, msgs) { messages.set(id, [...(messages.get(id) ?? []), ...structuredClone(msgs)]); },
    async countUserMessages(id) { return (messages.get(id) ?? []).filter(isUserText).length; },
    async getSpend(day) { return spend.get(day) ?? 0; },
    async addSpend(day, usd) { if (usd > 0) spend.set(day, (spend.get(day) ?? 0) + usd); },
    async cleanup() {},
  };
}

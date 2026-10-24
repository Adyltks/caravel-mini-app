-- ИИ-бот: диалоги, сообщения и дневной расход на Claude. Применить (только с «да» владельцев):
--   npx wrangler d1 execute aduka --remote --file=migrations/003_ai_bot.sql
-- Только новые таблицы, существующие данные не меняются.

CREATE TABLE IF NOT EXISTS bot_sessions (
  id TEXT PRIMARY KEY,                    -- "tg:<id>" (Telegram и мини-апп) или "web:<uuid>" (лендинг)
  source TEXT NOT NULL DEFAULT 'web',
  tg_id INTEGER,
  context TEXT NOT NULL DEFAULT '{}',     -- ниша, страница входа, UTM, ответы квиза
  verified INTEGER NOT NULL DEFAULT 0,    -- сайт: прошёл Turnstile
  lead_id INTEGER,                        -- номер заявки в aduka_orders, если бот её создал
  muted_until TEXT,                       -- бот молчит до этого времени (менеджер ответил сам)
  note TEXT NOT NULL DEFAULT '',          -- заметка для бота к следующей реплике (например, что написал менеджер)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bot_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,                  -- сообщение целиком в формате Claude API (JSON)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bot_messages_session ON bot_messages (session_id, id);

CREATE TABLE IF NOT EXISTS bot_spend (
  day TEXT PRIMARY KEY,                   -- дата по Бишкеку, ГГГГ-ММ-ДД
  usd REAL NOT NULL DEFAULT 0
);

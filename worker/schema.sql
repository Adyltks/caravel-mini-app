-- Таблицы Telegram Mini App в Cloudflare D1. Применить:
--   npx wrangler d1 execute aduka --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS aduka_services (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  short TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,
  term TEXT NOT NULL DEFAULT '',
  badge TEXT,
  icon TEXT NOT NULL DEFAULT 'catalog',
  featured INTEGER NOT NULL DEFAULT 0,
  includes TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL DEFAULT '[]',
  sort INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS aduka_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  username TEXT,
  tg_id INTEGER,
  services TEXT NOT NULL DEFAULT '[]',
  total INTEGER NOT NULL DEFAULT 0,
  comment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new'
);

CREATE TABLE IF NOT EXISTS aduka_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Номера заявок начинаются с 1001
INSERT OR IGNORE INTO sqlite_sequence (name, seq) VALUES ('aduka_orders', 1000);

INSERT OR IGNORE INTO aduka_settings (key, value) VALUES
  ('brand', 'Caravel'),
  ('currency', 'сом'),
  ('manager', 'https://t.me/caravel_manager');

INSERT OR IGNORE INTO aduka_services (id, title, short, description, price, term, badge, icon, featured, includes, steps, sort) VALUES
 ('ai','Адаптация AI под бизнес','Внедрим нейросети в продажи, поддержку и контент. Обучим команду.','Разберём ваши процессы и встроим нейросети туда, где они экономят время и приносят заявки: ответы клиентам, контент, аналитика.',50000,'2–4 недели','ХИТ','ai',1,'["Аудит процессов и точек роста","Настройка AI-ассистентов под ваши задачи","Интеграция с Telegram, CRM, таблицами","Обучение команды и инструкция"]','["Бриф","Аудит","Внедрение","Обучение"]',10),
 ('app','Создание приложений','Мобильные и Telegram Mini App под ключ.','Проектируем, дизайним и запускаем приложение: Telegram Mini App, веб-приложение или мобильное. Берём на себя всё от идеи до публикации.',80000,'от 4 недель',NULL,'app',0,'["Прототип и дизайн экранов","Разработка и тестирование","Подключение оплаты и уведомлений","Публикация и поддержка"]','["Бриф","Прототип","Разработка","Запуск"]',20),
 ('landing','Лендинги','Продающая страница под рекламу за 7 дней.','Одностраничный сайт, который превращает рекламный трафик в заявки: структура, тексты, дизайн и форма заявки в ваш Telegram.',25000,'5–7 дней','НОВОЕ','landing',0,'["Структура и тексты","Дизайн в вашем стиле","Форма заявки в Telegram","Подключение домена и аналитики"]','["Бриф","Текст","Дизайн","Запуск"]',30),
 ('ads','Таргет в Instagram','Реклама, которая приводит клиентов, а не лайки.','Настраиваем и ведём таргетированную рекламу в Instagram: креативы, аудитории, тесты и еженедельные отчёты.',30000,'ежемесячно',NULL,'ads',0,'["Стратегия и аудитории","Креативы и тексты","Запуск и оптимизация","Отчёт раз в неделю"]','["Бриф","Креативы","Запуск","Отчёты"]',40),
 ('bot','Чат-боты в Telegram','Отвечают клиентам, принимают заказы и записи 24/7.','Бот, который консультирует, собирает заявки, записывает на услуги и передаёт всё менеджеру. При желании с AI-ответами.',35000,'1–2 недели',NULL,'bot',0,'["Сценарий диалога","Приём заявок и записей","Уведомления менеджеру","AI-ответы на вопросы"]','["Сценарий","Сборка","Тест","Запуск"]',50),
 ('catalog','Каталоги','Каталог товаров или услуг в Telegram или на сайте.','Удобный каталог с фильтрами, карточками и кнопкой заказа. Товары загружаете из таблицы, обновление без программиста.',25000,'1–2 недели',NULL,'catalog',0,'["Структура и категории","Карточки с фото и ценами","Корзина и заказ в Telegram","Загрузка из Google Таблицы"]','["Структура","Дизайн","Загрузка","Запуск"]',60);

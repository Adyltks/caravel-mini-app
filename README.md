# Caravel Mini App

Telegram Mini App с каталогом услуг, Telegram-бот для заявок и админ-панель.
Всё работает на Cloudflare: Worker раздаёт мини апп и API, принимает вебхук бота,
данные лежат в базе D1. Заявки приходят менеджеру в Telegram и, при желании, в Google Таблицу.

```
webapp/   мини апп (статика, без сборки)
worker/   Cloudflare Worker: бот, API, админка; schema.sql для базы D1
```

## Как это работает

1. Пользователь открывает мини апп из бота, выбирает услуги, заполняет заявку.
2. Мини апп шлёт заявку на `/api/order` вместе с `initData`; воркер проверяет подпись Telegram,
   поэтому заявку нельзя подделать.
3. Заявка сохраняется в D1, уходит в чат менеджера (`ADMIN_CHAT_ID`) и в Google Таблицу.
4. Менеджер отвечает клиенту прямо из своего чата: ответ (reply) на сообщение с заявкой уходит клиенту от имени бота.
5. Админ-панель открывается в самом мини аппе (вкладка «Админ») у пользователей из `ADMIN_IDS`:
   услуги (добавить, изменить, скрыть, удалить), заявки со статусами, название бренда, валюта, ссылка на менеджера.

## Запуск на Cloudflare (один раз, ~15 минут)

Нужны: аккаунт Cloudflare, Node.js 18+, бот из @BotFather.

```bash
git clone https://github.com/Adyltks/caravel-mini-app
cd caravel-mini-app/worker
npm install
npx wrangler login                      # откроется браузер, войти в Cloudflare
```

**1. База D1**
```bash
npx wrangler d1 create aduka
```
Скопировать `database_id` из вывода в `wrangler.toml` (строка `database_id = "..."`), затем:
```bash
npm run db:remote                       # создаёт таблицы и демо-услуги
```

**2. Переменные** в `wrangler.toml`, блок `[vars]`:
- `ADMIN_CHAT_ID` — куда слать заявки (свой ID или ID группы; узнать можно командой `/id` боту после запуска).
- `ADMIN_IDS` — Telegram ID тех, кому видна админ-панель, через запятую.

**3. Секреты**
```bash
npx wrangler secret put BOT_TOKEN       # токен из @BotFather
npx wrangler secret put WEBHOOK_SECRET  # любая случайная строка, например из `openssl rand -hex 16`
```

**4. Деплой**
```bash
npm run deploy
```
В выводе будет адрес вида `https://caravel-mini-app.<аккаунт>.workers.dev`.

**5. Подключить бота**: открыть в браузере
`https://caravel-mini-app.<аккаунт>.workers.dev/setup?key=<WEBHOOK_SECRET>`.
Это регистрирует вебхук и кнопку «Каталог» в меню бота. Готово: напишите боту `/start`.

Дальше любое изменение кода: `npm run deploy`. Или подключите репозиторий в Cloudflare → Workers & Pages → Create → Import a repository, тогда деплой будет автоматически при каждом push (root directory: `worker`).

### Google Таблица (необязательно)
- В Google Cloud создать сервисный аккаунт, скачать JSON-ключ.
- Создать таблицу и выдать доступ «Редактор» на email сервисного аккаунта.
- В `wrangler.toml`: `GOOGLE_SHEET_ID` (из ссылки на таблицу), `GOOGLE_CLIENT_EMAIL` (client_email из ключа).
- Секрет: `npx wrangler secret put GOOGLE_PRIVATE_KEY` и вставить private_key из ключа.

## Локальная разработка
```bash
cd worker
cp .dev.vars.example .dev.vars          # BOT_TOKEN и WEBHOOK_SECRET для локального запуска
npm run db:local
npm run dev                             # http://127.0.0.1:8787
npm test
```

## Услуги и цены
Правятся в админ-панели мини аппа. Стартовые значения для новой базы лежат в `worker/schema.sql`,
резервная копия каталога для работы без API в `webapp/services.js`.

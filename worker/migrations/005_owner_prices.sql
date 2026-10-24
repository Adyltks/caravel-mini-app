-- Цены владельцев от 2026-10-24 (их текст — в чате с Claude, перенесено как есть).
-- Применить: npx wrangler d1 execute aduka --remote --file=migrations/005_owner_prices.sql
-- Меняет только цены, сроки и короткие описания услуг. «Адаптация AI» скрывается (active = 0), не удаляется.

UPDATE aduka_services SET term = '5–14 рабочих дней',
  description = 'Каталог товаров или прайс услуг по ссылке из шапки профиля. Корзина и заказ в WhatsApp одним сообщением. Тарифы: Старт от 15 000 сом (до 30 позиций, 5 рабочих дней), Магазин от 22 000 сом (до 100 позиций, 7 дней), Про от 28 000 сом (больше 100, 10–14 дней). Поддержка 14 дней и 2 круга правок бесплатно. Цены и наличие вы меняете в Google-таблице, новые позиции с фото добавляем мы.',
  updated_at = datetime('now') WHERE id = 'catalog';

UPDATE aduka_services SET price = 9000, term = '3–5 дней', short = 'Продающая страница под рекламу за 3–5 дней.', updated_at = datetime('now') WHERE id = 'landing';
UPDATE aduka_services SET price = 18000, term = 'в месяц + рекламный бюджет', updated_at = datetime('now') WHERE id = 'ads';
UPDATE aduka_services SET price = 5000, term = '2–4 дня', updated_at = datetime('now') WHERE id = 'bot';
UPDATE aduka_services SET title = 'Приложения в Telegram', price = 40000, term = '2–4 недели',
  short = 'Telegram Mini App под ключ.', updated_at = datetime('now') WHERE id = 'app';
UPDATE aduka_services SET active = 0, updated_at = datetime('now') WHERE id = 'ai';

UPDATE aduka_services SET title = 'Начало', price = 25000, updated_at = datetime('now') WHERE id = 'start';
UPDATE aduka_services SET price = 35000, updated_at = datetime('now') WHERE id = 'flow';

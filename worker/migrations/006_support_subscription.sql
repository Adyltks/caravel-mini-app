-- Поддержка после бесплатного срока — подписка в месяц по тарифу (решение владельцев 2026-10-24).
-- Применить: npx wrangler d1 execute aduka --remote --file=migrations/006_support_subscription.sql
UPDATE aduka_services SET
  description = replace(description, 'Поддержка 14 дней и 2 круга правок бесплатно.', 'Поддержка 14 дней и 2 круга правок бесплатно, дальше подписка 4 000 / 6 000 / 9 000 сом в месяц по тарифу.'),
  updated_at = datetime('now')
WHERE id = 'catalog';

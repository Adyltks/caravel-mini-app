-- Пакеты, категории, цена пилота, квиз-заявка. Применить к существующей базе:
--   npx wrangler d1 execute aduka --remote --file=migrations/002_packages_quiz.sql
ALTER TABLE aduka_services ADD COLUMN kind TEXT NOT NULL DEFAULT 'service';
ALTER TABLE aduka_services ADD COLUMN category TEXT NOT NULL DEFAULT '';
ALTER TABLE aduka_orders ADD COLUMN niche TEXT NOT NULL DEFAULT '';
ALTER TABLE aduka_orders ADD COLUMN budget TEXT NOT NULL DEFAULT '';

UPDATE aduka_services SET category = 'web' WHERE id IN ('app', 'landing', 'catalog') AND category = '';
UPDATE aduka_services SET category = 'ads' WHERE id = 'ads' AND category = '';
UPDATE aduka_services SET category = 'ai' WHERE id IN ('ai', 'bot') AND category = '';

INSERT OR IGNORE INTO aduka_settings (key, value) VALUES
  ('pilot_discount', '50'),
  ('guarantee', 'Если за первый месяц не будет ни одной заявки, вернём оплату за нашу работу. Рекламный бюджет не возвращается.');

INSERT OR IGNORE INTO aduka_services (id, title, short, description, price, term, badge, icon, featured, includes, steps, sort, kind, category) VALUES
 ('start','Старт','Лендинг или мини апп плюс настроенная реклама. Первые заявки за 2 недели.','Быстрый запуск для тех, кто хочет проверить спрос: собираем посадочную страницу или Telegram Mini App, подключаем форму заявки в Telegram и запускаем первую рекламную кампанию в Instagram.',25000,'разово',NULL,'landing',0,'["Лендинг или Telegram Mini App","Форма заявки в ваш Telegram","Настройка рекламы в Instagram","Передача всех доступов"]','["Бриф","Сборка","Запуск","Передача"]',1,'package',''),
 ('flow','Поток клиентов','Реклама, посадочная и бот, которые работают каждый месяц.','Система привлечения клиентов на постоянной основе: ведём рекламу, улучшаем посадочную по данным, бот в Telegram принимает заявки и записи круглосуточно. Отчёт каждую неделю.',30000,'в месяц + рекламный бюджет','ПОПУЛЯРНЫЙ','ads',1,'["Ведение рекламы в Instagram","Посадочная страница и её доработка","Бот для заявок и записей 24/7","Еженедельный отчёт по заявкам"]','["Бриф","Запуск","Оптимизация","Отчёты"]',2,'package',''),
 ('turnkey','Под ключ с AI','Полная система плюс AI-ассистент, который отвечает клиентам и ведёт их до записи.','Для тех, кому нужен результат без участия: реклама, посадочная, бот и AI-ассистент, обученный на ваших услугах. Он отвечает на вопросы, квалифицирует заявки и записывает клиентов, а менеджер получает только готовых.',50000,'запуск, далее от 30 000 сом в месяц',NULL,'ai',0,'["Всё из пакета «Поток клиентов»","AI-ассистент на ваших услугах и ценах","Квалификация заявок и запись","Интеграция с CRM или таблицей"]','["Аудит","Запуск","Обучение AI","Сопровождение"]',3,'package','');

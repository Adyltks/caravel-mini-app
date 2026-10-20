/* Запись заявок в Google Таблицу через сервисный аккаунт. */
const { google } = require("googleapis");

const { GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SHEET_TAB = "Заявки" } = process.env;

let api = null;
function client() {
  if (api) return api;
  if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  api = google.sheets({ version: "v4", auth });
  return api;
}

const HEADER = ["№", "Дата", "Имя", "Телефон", "Telegram", "Услуги", "Сумма от", "Комментарий", "Статус"];

async function append(order) {
  const s = client();
  if (!s) return; // таблица не настроена, пропускаем
  const range = `'${GOOGLE_SHEET_TAB}'!A:I`;
  const head = await s.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: `'${GOOGLE_SHEET_TAB}'!A1:I1` }).catch(() => null);
  if (!head || !head.data.values || !head.data.values.length) {
    await s.spreadsheets.values.update({ spreadsheetId: GOOGLE_SHEET_ID, range, valueInputOption: "RAW", requestBody: { values: [HEADER] } });
  }
  await s.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID, range, valueInputOption: "USER_ENTERED",
    requestBody: { values: [[order.id, new Date(order.date).toLocaleString("ru-RU"), order.name, order.phone, order.username, order.services.join(", "), order.total, order.comment, "Новая"]] },
  });
}

module.exports = { append };

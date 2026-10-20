/* Запись заявки в Google Таблицу через сервисный аккаунт (без SDK, на WebCrypto). */
const HEADER = ["№", "Дата", "Имя", "Телефон", "Telegram", "Услуги", "Сумма от", "Комментарий", "Статус"];
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function accessToken(email, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const pem = privateKeyPem.replace(/\\n/g, "\n").replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Google auth: " + JSON.stringify(j));
  return j.access_token;
}

export async function appendOrder(env, order) {
  const { GOOGLE_SHEET_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_TAB = "Заявки" } = env;
  if (!GOOGLE_SHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) return; // таблица не настроена
  const token = await accessToken(GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent(`'${GOOGLE_SHEET_TAB}'!A:I`)}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const head = await fetch(`${base.replace("A:I", "A1:I1")}`, { headers }).then((r) => r.json()).catch(() => null);
  if (!head || !head.values || !head.values.length) {
    await fetch(`${base}?valueInputOption=RAW`, { method: "PUT", headers, body: JSON.stringify({ values: [HEADER] }) });
  }
  const row = [order.id, new Date(order.created_at).toLocaleString("ru-RU"), order.name, order.phone, order.username || "", order.services.join(", "), order.total, order.comment, "Новая"];
  const r = await fetch(`${base}:append?valueInputOption=USER_ENTERED`, { method: "POST", headers, body: JSON.stringify({ values: [row] }) });
  if (!r.ok) throw new Error("Sheets: " + (await r.text()));
}

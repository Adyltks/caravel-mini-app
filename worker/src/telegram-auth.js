/* Проверка подписи initData из мини-аппа Telegram. Возвращает пользователя или null.
   Подпись старше maxAgeSec не принимаем: иначе однажды перехваченная строка работала бы вечно
   (а за ней теперь платный чат с ИИ). Мини-апп получает свежую подпись при каждом открытии. */
export async function verifyInitData(initData, botToken, { maxAgeSec = 24 * 3600, now = Date.now() } = {}) {
  if (!initData || !botToken) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash") || "";
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const enc = new TextEncoder();
  const hmac = async (keyBytes, data) => crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(data));
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const sig = [...new Uint8Array(await hmac(secret, check))].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Сравнение за постоянное время: по скорости ответа не понять, сколько символов подписи совпало
  let diff = sig.length ^ hash.length;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ (hash.charCodeAt(i) || 0);
  if (diff !== 0) return null;
  const authDate = Number(p.get("auth_date"));
  if (!authDate || now / 1000 - authDate > maxAgeSec) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}

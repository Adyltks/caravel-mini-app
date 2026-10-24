/* Проверка подписи initData из мини-аппа Telegram. Возвращает пользователя или null. */
export async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const enc = new TextEncoder();
  const hmac = async (keyBytes, data) => crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(data));
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const sig = [...new Uint8Array(await hmac(secret, check))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (sig !== hash) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}

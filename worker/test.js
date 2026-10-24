/* Проверки без сети: подпись initData и нормализация услуги. Запуск: npm test */
import assert from "node:assert";
import crypto from "node:crypto";
import { verifyInitData } from "./src/telegram-auth.js";
import { normalize } from "./src/db.js";

const TOKEN = "111:test";
function sign(userObj) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q1", user: JSON.stringify(userObj) });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}
const ok = sign({ id: 42, first_name: "Тест" });
assert.strictEqual((await verifyInitData(ok, TOKEN)).id, 42, "валидная подпись должна проходить");
assert.strictEqual(await verifyInitData(ok.replace(/hash=[0-9a-f]+/, "hash=" + "0".repeat(64)), TOKEN), null, "подделка должна отклоняться");
assert.strictEqual(await verifyInitData(ok, "222:other"), null, "чужой токен не подходит");
assert.strictEqual(await verifyInitData("", TOKEN), null);
assert.strictEqual(await verifyInitData(ok, TOKEN, { now: Date.now() + 25 * 3600 * 1000 }), null, "подпись старше суток не принимается");

const s = normalize({ id: "SEO Promo!", title: " SEO ", price: "15000", includes: "Аудит\n\nСемантика", steps: "Бриф, Работа", featured: "true", active: "false" });
assert.strictEqual(s.id, "seopromo");
assert.deepStrictEqual(s.includes, ["Аудит", "Семантика"]);
assert.deepStrictEqual(s.steps, ["Бриф", "Работа"]);
assert.strictEqual(s.featured, 1);
assert.strictEqual(s.active, 0);
assert.strictEqual(s.icon, "catalog");
console.log("ok");

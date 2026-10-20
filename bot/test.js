/* Проверка подписи initData без сети. */
process.env.BOT_TOKEN = "111:test";
process.env.ADMIN_CHAT_ID = "1";
process.env.WEBAPP_URL = "https://example.com";
process.env.PORT = "0";
const crypto = require("crypto");
const assert = require("assert");
const { verifyInitData } = require("./index.js");

const user = JSON.stringify({ id: 42, first_name: "Тест", username: "tester" });
const params = new URLSearchParams({ auth_date: "1700000000", query_id: "q1", user });
const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));

assert.strictEqual(verifyInitData(params.toString()).id, 42, "валидная подпись должна проходить");
assert.strictEqual(verifyInitData(params.toString().replace(/hash=./, "hash=0")), null, "подделка должна отклоняться");
assert.strictEqual(verifyInitData(""), null);
console.log("ok");
process.exit(0);

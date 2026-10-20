/* Проверки без сети: подпись initData, доступ к админке, работа хранилища в памяти. */
process.env.BOT_TOKEN = "111:test";
process.env.ADMIN_CHAT_ID = "1";
process.env.WEBAPP_URL = "https://example.com";
process.env.ADMIN_IDS = "42";
const crypto = require("crypto");
const assert = require("assert");
const http = require("http");
const { verifyInitData, server } = require("./index.js");

function sign(userObj) {
  const params = new URLSearchParams({ auth_date: "1700000000", query_id: "q1", user: JSON.stringify(userObj) });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}
const admin = sign({ id: 42, first_name: "Админ" });
const guest = sign({ id: 7, first_name: "Гость" });

assert.strictEqual(verifyInitData(admin).id, 42, "валидная подпись должна проходить");
assert.strictEqual(verifyInitData(admin.replace(/hash=./, "hash=0")), null, "подделка должна отклоняться");
assert.strictEqual(verifyInitData(""), null);

const call = (method, path, body) => new Promise((resolve, reject) => {
  const req = http.request({ port: server.address().port, method, path, headers: { "Content-Type": "application/json" } }, (res) => {
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
  });
  req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
});

server.listen(0, async () => {
  try {
    const cat = await call("GET", "/api/catalog");
    assert.strictEqual(cat.body.services.length, 6, "каталог из памяти");
    assert.strictEqual(cat.body.settings.brand, "Caravel");

    const denied = await call("POST", "/api/admin/services", { initData: guest });
    assert.strictEqual(denied.status, 400, "гостю админка закрыта");
    const me = await call("POST", "/api/me", { initData: admin });
    assert.strictEqual(me.body.admin, true);

    const saved = await call("POST", "/api/admin/services/save", { initData: admin, service: { id: "seo", title: "SEO", price: "15000", includes: "Аудит\nСемантика", steps: "Бриф, Работа" } });
    assert.strictEqual(saved.body.service.includes.length, 2);
    assert.strictEqual(saved.body.service.steps[1], "Работа");
    assert.strictEqual((await call("GET", "/api/catalog")).body.services.length, 7);

    const hidden = await call("POST", "/api/admin/services/save", { initData: admin, service: { ...saved.body.service, active: false } });
    assert.strictEqual(hidden.body.ok, true);
    assert.strictEqual((await call("GET", "/api/catalog")).body.services.length, 6, "скрытая услуга не видна клиентам");
    assert.strictEqual((await call("POST", "/api/admin/services", { initData: admin })).body.services.length, 7, "но видна в админке");

    await call("POST", "/api/admin/services/delete", { initData: admin, id: "seo" });
    assert.strictEqual((await call("POST", "/api/admin/services", { initData: admin })).body.services.length, 6);

    const bad = await call("POST", "/api/order", { initData: guest, services: ["ai"], phone: "123" });
    assert.strictEqual(bad.body.ok, false, "короткий телефон отклоняется");
    console.log("ok");
    process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
});

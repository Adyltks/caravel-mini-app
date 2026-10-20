/* Хранилище услуг, заявок и настроек в Cloudflare D1 (SQLite). */
const ICONS = ["ai", "app", "landing", "ads", "bot", "catalog"];
export const STATUSES = ["new", "in_progress", "done", "cancelled"];

const parse = (s) => { try { return JSON.parse(s || "[]"); } catch { return []; } };
const rowToService = (r) => ({ ...r, featured: !!r.featured, active: !!r.active, includes: parse(r.includes), steps: parse(r.steps) });
const rowToOrder = (r) => ({ ...r, services: parse(r.services), created_at: r.created_at.endsWith("Z") ? r.created_at : r.created_at.replace(" ", "T") + "Z" });

/** Приводит услугу к виду, который понимает мини апп. */
export function normalize(s) {
  const list = (v, sep) => (Array.isArray(v) ? v.map(String) : String(v || "").split(sep).map((x) => x.trim())).filter(Boolean);
  return {
    id: String(s.id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || "s" + Date.now().toString(36),
    title: String(s.title || "").trim(),
    short: String(s.short || "").trim(),
    description: String(s.description || "").trim(),
    price: Math.max(0, parseInt(s.price, 10) || 0),
    term: String(s.term || "").trim(),
    badge: String(s.badge || "").trim() || null,
    icon: ICONS.includes(s.icon) ? s.icon : "catalog",
    featured: s.featured === true || s.featured === "true" ? 1 : 0,
    includes: list(s.includes, "\n"),
    steps: list(s.steps, /[\n,]/),
    sort: parseInt(s.sort, 10) || 100,
    active: s.active === false || s.active === "false" ? 0 : 1,
  };
}

export function makeDb(DB) {
  return {
    async listServices(all = false) {
      const { results } = await DB.prepare(`SELECT * FROM aduka_services ${all ? "" : "WHERE active = 1"} ORDER BY sort, title`).all();
      return results.map(rowToService);
    },
    async getSettings() {
      const { results } = await DB.prepare("SELECT key, value FROM aduka_settings").all();
      return Object.fromEntries(results.map((r) => [r.key, r.value]));
    },
    async saveSettings(patch) {
      const rows = Object.entries(patch || {}).filter(([k]) => ["brand", "currency", "manager"].includes(k));
      if (rows.length) await DB.batch(rows.map(([k, v]) => DB.prepare("INSERT INTO aduka_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, String(v).trim())));
      return this.getSettings();
    },
    async saveService(input) {
      const s = normalize(input);
      if (!s.title) throw new Error("Укажите название услуги");
      await DB.prepare(`INSERT INTO aduka_services (id, title, short, description, price, term, badge, icon, featured, includes, steps, sort, active, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, short=excluded.short, description=excluded.description, price=excluded.price, term=excluded.term,
          badge=excluded.badge, icon=excluded.icon, featured=excluded.featured, includes=excluded.includes, steps=excluded.steps, sort=excluded.sort, active=excluded.active, updated_at=excluded.updated_at`)
        .bind(s.id, s.title, s.short, s.description, s.price, s.term, s.badge, s.icon, s.featured, JSON.stringify(s.includes), JSON.stringify(s.steps), s.sort, s.active).run();
      return rowToService(await DB.prepare("SELECT * FROM aduka_services WHERE id = ?").bind(s.id).first());
    },
    async deleteService(id) {
      await DB.prepare("DELETE FROM aduka_services WHERE id = ?").bind(String(id)).run();
    },
    async createOrder(o) {
      const r = await DB.prepare("INSERT INTO aduka_orders (name, phone, username, tg_id, services, total, comment) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *")
        .bind(o.name, o.phone, o.username, o.tg_id, JSON.stringify(o.services), o.total, o.comment).first();
      return rowToOrder(r);
    },
    async listOrders(limit = 100) {
      const { results } = await DB.prepare("SELECT * FROM aduka_orders ORDER BY id DESC LIMIT ?").bind(limit).all();
      return results.map(rowToOrder);
    },
    async setOrderStatus(id, status) {
      if (!STATUSES.includes(status)) throw new Error("Неизвестный статус");
      const r = await DB.prepare("UPDATE aduka_orders SET status = ? WHERE id = ? RETURNING *").bind(status, Number(id)).first();
      return r && rowToOrder(r);
    },
  };
}

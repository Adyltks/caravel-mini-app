/* Хранилище услуг, заявок и настроек.
   С Supabase (SUPABASE_URL + SUPABASE_SERVICE_KEY) данные живут в базе,
   без него работает в памяти из webapp/services.js (для локального теста). */
const { createClient } = require("@supabase/supabase-js");
const seed = require("../webapp/services.js");

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const sb = SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const SERVICE_FIELDS = ["id", "title", "short", "description", "price", "term", "badge", "icon", "featured", "includes", "steps", "sort", "active"];
const STATUSES = ["new", "in_progress", "done", "cancelled"];

/** Приводит услугу к виду, который понимает мини апп. */
function normalize(s) {
  return {
    id: String(s.id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || undefined,
    title: String(s.title || "").trim(),
    short: String(s.short || "").trim(),
    description: String(s.description || s.desc || "").trim(),
    price: Math.max(0, parseInt(s.price, 10) || 0),
    term: String(s.term || "").trim(),
    badge: String(s.badge || "").trim() || null,
    icon: ["ai", "app", "landing", "ads", "bot", "catalog"].includes(s.icon) ? s.icon : "catalog",
    featured: !!s.featured,
    includes: Array.isArray(s.includes) ? s.includes.map(String).filter(Boolean) : String(s.includes || "").split("\n").map((x) => x.trim()).filter(Boolean),
    steps: Array.isArray(s.steps) ? s.steps.map(String).filter(Boolean) : String(s.steps || "").split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
    sort: parseInt(s.sort, 10) || 100,
    active: s.active !== false,
  };
}

/* ---------- режим в памяти ---------- */
const mem = {
  services: seed.services.map((s, i) => normalize({ ...s, description: s.desc, sort: (i + 1) * 10 })),
  orders: [],
  settings: { brand: seed.brand, currency: seed.currency, manager: seed.manager },
  nextId: 1001,
};

async function listServices(all = false) {
  if (!sb) return mem.services.filter((s) => all || s.active).sort((a, b) => a.sort - b.sort);
  let q = sb.from("aduka_services").select("*").order("sort");
  if (!all) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

async function getSettings() {
  if (!sb) return { ...mem.settings };
  const { data, error } = await sb.from("aduka_settings").select("key,value");
  if (error) throw error;
  return Object.fromEntries(data.map((r) => [r.key, r.value]));
}

async function saveSettings(patch) {
  const allowed = ["brand", "currency", "manager"];
  const rows = Object.entries(patch).filter(([k]) => allowed.includes(k)).map(([key, value]) => ({ key, value: String(value).trim() }));
  if (!sb) { rows.forEach((r) => (mem.settings[r.key] = r.value)); return getSettings(); }
  const { error } = await sb.from("aduka_settings").upsert(rows);
  if (error) throw error;
  return getSettings();
}

async function saveService(input) {
  const s = normalize(input);
  if (!s.id) s.id = "s" + Date.now().toString(36);
  if (!s.title) throw new Error("Укажите название услуги");
  if (!sb) {
    const i = mem.services.findIndex((x) => x.id === s.id);
    i >= 0 ? (mem.services[i] = s) : mem.services.push(s);
    return s;
  }
  const { data, error } = await sb.from("aduka_services").upsert({ ...s, updated_at: new Date().toISOString() }).select().single();
  if (error) throw error;
  return data;
}

async function deleteService(id) {
  if (!sb) { mem.services = mem.services.filter((s) => s.id !== id); return; }
  const { error } = await sb.from("aduka_services").delete().eq("id", id);
  if (error) throw error;
}

async function createOrder(o) {
  if (!sb) { const row = { id: mem.nextId++, created_at: new Date().toISOString(), status: "new", ...o }; mem.orders.unshift(row); return row; }
  const { data, error } = await sb.from("aduka_orders").insert(o).select().single();
  if (error) throw error;
  return data;
}

async function listOrders(limit = 100) {
  if (!sb) return mem.orders.slice(0, limit);
  const { data, error } = await sb.from("aduka_orders").select("*").order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

async function setOrderStatus(id, status) {
  if (!STATUSES.includes(status)) throw new Error("Неизвестный статус");
  if (!sb) { const o = mem.orders.find((x) => String(x.id) === String(id)); if (o) o.status = status; return o; }
  const { data, error } = await sb.from("aduka_orders").update({ status }).eq("id", id).select().single();
  if (error) throw error;
  return data;
}

module.exports = { enabled: !!sb, listServices, getSettings, saveSettings, saveService, deleteService, createOrder, listOrders, setOrderStatus, SERVICE_FIELDS, STATUSES };

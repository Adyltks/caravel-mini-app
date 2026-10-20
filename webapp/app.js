/* Caravel Mini App: каталог услуг, карточка, заявка, админ-панель. */
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  const API = (window.CARAVEL_API || "").replace(/\/$/, ""); // адрес сервера бота, задаётся в config.js
  const app = document.getElementById("app");
  const tabs = document.getElementById("tabs");
  const cart = new Set(JSON.parse(sessionStorage.getItem("cart") || "[]"));
  let C = { ...window.CARAVEL, services: window.CARAVEL.services.map((s) => ({ ...s, description: s.desc })) };
  let view = { name: "catalog" };
  let lastOrder = null;
  let isAdmin = false;
  let adminData = { services: [], orders: [] };
  const STATUS = { new: "Новая", in_progress: "В работе", done: "Выполнена", cancelled: "Отменена" };
  const ICONS = ["ai", "app", "landing", "ads", "bot", "catalog"];

  if (tg) {
    tg.ready();
    tg.expand();
    tg.setHeaderColor("#0b0b0c");
    tg.setBackgroundColor("#0b0b0c");
    tg.BackButton.onClick(back);
  }

  const initData = () => (tg ? tg.initData : "");
  const money = (n) => Number(n || 0).toLocaleString("ru-RU") + " " + C.currency;
  const byId = (id) => C.services.find((s) => s.id === id) || adminData.services.find((s) => s.id === id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const icon = (name) => `<svg><use href="#i-${ICONS.includes(name) ? name : "catalog"}"/></svg>`;

  async function post(path, body) {
    const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, initData: initData() }) });
    const res = await r.json().catch(() => ({}));
    if (!r.ok || !res.ok) throw new Error(res.error || "Ошибка сервера");
    return res;
  }

  async function loadCatalog() {
    if (!API) return;
    try {
      const r = await fetch(API + "/api/catalog");
      const res = await r.json();
      if (res.ok) { C = { ...C, ...res.settings, services: res.services }; applySettings(); render(); }
    } catch (e) { console.warn("Каталог из services.js:", e.message); }
    try {
      const me = await post("/api/me", {});
      isAdmin = !!me.admin;
      document.getElementById("adminTab").hidden = !isAdmin;
    } catch {}
  }
  function applySettings() { document.getElementById("managerTab").href = C.manager; }

  function saveCart() {
    sessionStorage.setItem("cart", JSON.stringify([...cart]));
    const el = document.getElementById("cartCount");
    el.textContent = cart.size;
    el.hidden = cart.size === 0;
  }
  function toggle(id) {
    cart.has(id) ? cart.delete(id) : cart.add(id);
    tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred("light");
    saveCart();
    render();
  }
  function go(name, arg) { view = { name, arg }; window.scrollTo(0, 0); render(); }
  function back() {
    if (view.name === "adminEdit" || view.name === "adminOrders" || view.name === "adminSettings") return go("admin");
    go("catalog");
  }

  /* ---------- клиентские экраны ---------- */
  function catalog() {
    const featured = C.services.filter((s) => s.featured);
    const rest = C.services.filter((s) => !s.featured);
    const card = (s, big) => `
      <button class="svc fade-in" data-open="${s.id}">
        <div class="cover">${s.badge ? `<span class="badge">${esc(s.badge)}</span>` : ""}${icon(s.icon)}</div>
        <div class="body">
          <div class="t">${esc(s.title)}</div>
          ${big ? `<div class="d">${esc(s.short)}</div>` : ""}
          <div class="row">
            <div><div class="price">от ${money(s.price)}</div>${big ? `<div class="meta">${esc(s.term)}</div>` : ""}</div>
            <span class="plus ${cart.has(s.id) ? "on" : ""}" data-add="${s.id}">${cart.has(s.id) ? "✓" : "+"}</span>
          </div>
        </div>
      </button>`;
    return `
      <div class="brand serif"><span class="logo">${esc(C.brand[0] || "C")}</span>${esc(C.brand)}</div>
      <div class="eyebrow">${C.services.length} услуг под ключ</div>
      <h1 class="serif">Digital-решения <em>для бизнеса</em></h1>
      <p class="sub">Выберите услуги, узнайте детали и оставьте заявку в пару касаний.</p>
      ${featured.map((s) => card(s, true)).join("")}
      <div class="grid">${rest.map((s) => card(s, false)).join("")}</div>`;
  }

  function detail(id) {
    const s = byId(id);
    if (!s) return catalog();
    const inCart = cart.has(id);
    return `
      <div class="hero">${s.badge ? `<span class="badge">${esc(s.badge)}</span>` : ""}${icon(s.icon)}</div>
      <div class="eyebrow">Услуга</div>
      <h2 class="serif">${esc(s.title)}</h2>
      <div class="chips">
        <div class="chip g">Стоимость<b>от ${money(s.price)}</b></div>
        ${s.term ? `<div class="chip">Срок<b>${esc(s.term)}</b></div>` : ""}
        <div class="chip">Формат<b>под ключ</b></div>
      </div>
      <p class="sub" style="margin-top:14px">${esc(s.description)}</p>
      ${s.includes && s.includes.length ? `<div class="sec">Что входит</div>${s.includes.map((x) => `<div class="li"><i>✓</i>${esc(x)}</div>`).join("")}` : ""}
      ${s.steps && s.steps.length ? `<div class="sec">Как работаем</div><div class="steps">${s.steps.map((x, i) => `<div class="st"><b class="serif">0${i + 1}</b>${esc(x)}</div>`).join("")}</div>` : ""}
      <div class="bar">
        <button class="btn o" data-add="${s.id}">${inCart ? "В заявке ✓" : "В заявку +"}</button>
        <button class="btn g" data-order="${s.id}">Оставить заявку</button>
      </div>`;
  }

  function order() {
    const items = [...cart].map(byId).filter(Boolean);
    const u = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
    const name = u ? [u.first_name, u.last_name].filter(Boolean).join(" ") : "";
    if (!items.length) {
      return `
        <div class="eyebrow">Оформление</div>
        <h1 class="serif">Ваша <em>заявка</em></h1>
        <div class="empty">Вы пока ничего не выбрали.<br>Добавьте услуги из каталога плюсом.</div>
        <div class="bar"><button class="btn g" data-go="catalog">К услугам</button></div>`;
    }
    return `
      <div class="eyebrow">Оформление</div>
      <h1 class="serif">Ваша <em>заявка</em></h1>
      <div class="field"><label>Выбранные услуги · ${items.length}</label>
        ${items.map((s) => `<div class="sel"><div class="ic">${icon(s.icon)}</div><div><div class="n">${esc(s.title)}</div><div class="p">от ${money(s.price)}</div></div><button class="rm" data-add="${s.id}" aria-label="Убрать">✕</button></div>`).join("")}
      </div>
      <form id="orderForm" novalidate>
        <div class="field"><label>Имя</label><div class="inp"><input name="name" value="${esc(name)}" placeholder="Как к вам обращаться" autocomplete="name">${u ? '<span class="tgtag">из Telegram</span>' : ""}</div></div>
        <div class="field"><label>Телефон</label><div class="inp" id="phoneBox"><input name="phone" type="tel" inputmode="tel" placeholder="+996 500 000 000" autocomplete="tel"></div></div>
        <div class="field"><label>Комментарий</label><div class="inp"><textarea name="comment" placeholder="Расскажите о задаче, сроках или бюджете"></textarea></div></div>
        <div class="note"><span>🔒</span><span>Заявка сразу придёт менеджеру в Telegram. ${u && u.username ? "Ваш @" + esc(u.username) + " подставим автоматически." : ""}</span></div>
        <div class="msg" id="formMsg"></div>
        <div class="bar"><button class="btn g" type="submit" id="submitBtn">Отправить заявку</button></div>
      </form>`;
  }

  function success() {
    const o = lastOrder;
    return `
      <div class="ok fade-in">
        <div class="ring">${icon("check")}</div>
        <div class="eyebrow" style="margin-top:28px">Заявка №${esc(o.id)}</div>
        <h1 class="serif" style="font-size:32px">Заявка <em>отправлена</em></h1>
        <p class="sub" style="max-width:290px">Менеджер свяжется с вами в Telegram в течение 15 минут в рабочее время.</p>
        <div class="ticket">
          <div class="tr"><span>Услуги</span><div style="text-align:right">${o.services.map(esc).join(", ")}</div></div>
          <div class="tr"><span>Имя</span>${esc(o.name)}</div>
          <div class="tr"><span>Телефон</span>${esc(o.phone)}</div>
          <div class="tr"><span>Статус</span><b>Новая</b></div>
        </div>
      </div>
      <div class="bar col">
        <button class="btn g" data-go="catalog" style="flex:0 0 52px">Вернуться к услугам</button>
        <a class="btn o" href="${esc(C.manager)}" target="_blank" rel="noopener" style="flex:0 0 52px;padding:0">Написать менеджеру</a>
      </div>`;
  }

  async function submit(form) {
    const btn = document.getElementById("submitBtn");
    const msg = document.getElementById("formMsg");
    const name = form.name.value.trim();
    const phone = form.phone.value.trim();
    const comment = form.comment.value.trim();
    msg.textContent = "";
    document.getElementById("phoneBox").classList.remove("err");
    if (!/^\+?[\d\s()-]{10,18}$/.test(phone)) {
      document.getElementById("phoneBox").classList.add("err");
      msg.textContent = "Укажите телефон, чтобы менеджер мог связаться.";
      return;
    }
    const payload = { name, phone, comment, services: [...cart] };
    btn.disabled = true;
    btn.textContent = "Отправляем…";
    try {
      let res;
      if (API) res = await post("/api/order", payload);
      else if (tg && tg.sendData) { tg.sendData(JSON.stringify({ ...payload, initData: initData() })); res = { id: "—" }; }
      else res = { id: "DEMO" };
      lastOrder = { id: res.id, name: name || "—", phone, services: [...cart].map((id) => byId(id).title) };
      cart.clear();
      saveCart();
      tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred("success");
      go("success");
    } catch (e) {
      msg.textContent = "Не удалось отправить: " + e.message + ". Попробуйте ещё раз или напишите менеджеру.";
      btn.disabled = false;
      btn.textContent = "Отправить заявку";
    }
  }

  /* ---------- админ-панель ---------- */
  function admin() {
    const list = adminData.services;
    return `
      <div class="eyebrow">Админ-панель</div>
      <h1 class="serif">Услуги <em>${list.length}</em></h1>
      <div class="arow">
        <button class="abtn" data-go="adminOrders">Заявки</button>
        <button class="abtn" data-go="adminSettings">Настройки</button>
        <button class="abtn g" data-edit="new">+ Услуга</button>
      </div>
      <div class="msg" id="adminMsg"></div>
      ${list.length ? "" : '<div class="empty">Загружаю…</div>'}
      ${list.map((s) => `
        <div class="arow-item ${s.active ? "" : "off"}">
          <div class="ic">${icon(s.icon)}</div>
          <div class="grow"><div class="n">${esc(s.title)} ${s.active ? "" : '<span class="tgtag">скрыта</span>'}</div><div class="p">от ${money(s.price)} · ${esc(s.term)}</div></div>
          <button class="abtn sm" data-edit="${s.id}">Изменить</button>
        </div>`).join("")}`;
  }

  function adminEdit(id) {
    const s = id === "new" ? { id: "", title: "", short: "", description: "", price: "", term: "", badge: "", icon: "catalog", featured: false, includes: [], steps: [], sort: 100, active: true } : adminData.services.find((x) => x.id === id);
    if (!s) return admin();
    const f = (label, name, value, ph, type) => `<div class="field"><label>${label}</label><div class="inp"><${type === "ta" ? "textarea" : "input"} name="${name}" placeholder="${esc(ph || "")}" ${type === "ta" ? "" : `value="${esc(value)}"`}>${type === "ta" ? esc(value) : ""}${type === "ta" ? "</textarea>" : ""}</div></div>`;
    return `
      <div class="eyebrow">${id === "new" ? "Новая услуга" : "Редактирование"}</div>
      <h2 class="serif">${esc(s.title || "Услуга")}</h2>
      <form id="serviceForm" novalidate>
        <input type="hidden" name="id" value="${esc(s.id)}">
        ${f("Название", "title", s.title, "Например, SEO-продвижение")}
        ${f("Коротко (в каталоге)", "short", s.short, "Одна фраза о выгоде")}
        ${f("Описание", "description", s.description, "Подробно, что получает клиент", "ta")}
        <div class="two">${f("Цена от", "price", s.price, "50000")}${f("Срок", "term", s.term, "1–2 недели")}</div>
        <div class="two">${f("Метка", "badge", s.badge || "", "ХИТ / НОВОЕ")}${f("Порядок", "sort", s.sort, "100")}</div>
        <div class="field"><label>Иконка</label><div class="icons">${ICONS.map((i) => `<label class="ico ${s.icon === i ? "on" : ""}"><input type="radio" name="icon" value="${i}" ${s.icon === i ? "checked" : ""}>${icon(i)}</label>`).join("")}</div></div>
        ${f("Что входит (каждый пункт с новой строки)", "includes", (s.includes || []).join("\n"), "Аудит\nДизайн\nЗапуск", "ta")}
        ${f("Этапы (через запятую)", "steps", (s.steps || []).join(", "), "Бриф, Дизайн, Запуск")}
        <label class="check"><input type="checkbox" name="featured" ${s.featured ? "checked" : ""}> Показывать большой карточкой наверху</label>
        <label class="check"><input type="checkbox" name="active" ${s.active ? "checked" : ""}> Показывать клиентам</label>
        <div class="msg" id="adminMsg"></div>
        ${id !== "new" ? `<button type="button" class="abtn danger" data-del="${esc(s.id)}">Удалить услугу</button>` : ""}
        <div class="bar"><button class="btn o" type="button" data-go="admin">Отмена</button><button class="btn g" type="submit" id="saveBtn">Сохранить</button></div>
      </form>`;
  }

  function adminOrders() {
    const list = adminData.orders;
    return `
      <div class="eyebrow">Админ-панель</div>
      <h1 class="serif">Заявки <em>${list.length}</em></h1>
      <div class="msg" id="adminMsg"></div>
      ${list.length ? "" : '<div class="empty">Заявок пока нет.</div>'}
      ${list.map((o) => `
        <div class="ticket" style="margin-top:12px">
          <div class="tr"><span>№${esc(o.id)}</span><div>${new Date(o.created_at).toLocaleString("ru-RU")}</div></div>
          <div class="tr"><span>Клиент</span><div style="text-align:right">${esc(o.name)} ${o.username ? esc(o.username) : ""}<br><a href="tel:${esc(o.phone)}" style="color:var(--gold)">${esc(o.phone)}</a></div></div>
          <div class="tr"><span>Услуги</span><div style="text-align:right">${(o.services || []).map(esc).join(", ")}</div></div>
          ${o.comment ? `<div class="tr"><span>Комментарий</span><div style="text-align:right">${esc(o.comment)}</div></div>` : ""}
          <div class="tr"><span>Статус</span><select class="status" data-order-id="${esc(o.id)}">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${o.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        </div>`).join("")}
      <div class="bar"><button class="btn o" data-go="admin">Назад</button></div>`;
  }

  function adminSettings() {
    return `
      <div class="eyebrow">Админ-панель</div>
      <h1 class="serif">Настройки</h1>
      <form id="settingsForm" novalidate>
        <div class="field"><label>Название бренда</label><div class="inp"><input name="brand" value="${esc(C.brand)}"></div></div>
        <div class="field"><label>Валюта</label><div class="inp"><input name="currency" value="${esc(C.currency)}" placeholder="сом"></div></div>
        <div class="field"><label>Ссылка «Написать менеджеру»</label><div class="inp"><input name="manager" value="${esc(C.manager)}" placeholder="https://t.me/username"></div></div>
        <div class="msg" id="adminMsg"></div>
        <div class="bar"><button class="btn o" type="button" data-go="admin">Отмена</button><button class="btn g" type="submit">Сохранить</button></div>
      </form>`;
  }

  async function loadAdmin(what) {
    try {
      if (what === "orders") adminData.orders = (await post("/api/admin/orders", {})).orders;
      else adminData.services = (await post("/api/admin/services", {})).services;
      render();
    } catch (e) { showMsg(e.message); }
  }
  function showMsg(text, ok) {
    const el = document.getElementById("adminMsg");
    if (el) { el.textContent = text; el.style.color = ok ? "var(--gold)" : ""; }
  }
  async function saveService(form) {
    const fd = new FormData(form);
    const service = Object.fromEntries(fd.entries());
    service.featured = fd.has("featured");
    service.active = fd.has("active");
    const btn = document.getElementById("saveBtn");
    btn.disabled = true;
    try {
      await post("/api/admin/services/save", { service });
      await loadCatalogSilently();
      adminData.services = (await post("/api/admin/services", {})).services;
      go("admin");
    } catch (e) { showMsg(e.message); btn.disabled = false; }
  }
  async function loadCatalogSilently() {
    try { const res = await (await fetch(API + "/api/catalog")).json(); if (res.ok) { C = { ...C, ...res.settings, services: res.services }; applySettings(); } } catch {}
  }

  /* ---------- рендер ---------- */
  const screens = { catalog, order, success, admin, adminOrders, adminSettings };
  function render() {
    app.innerHTML = screens[view.name] ? screens[view.name]() : view.name === "adminEdit" ? adminEdit(view.arg) : detail(view.arg);
    document.body.classList.toggle("has-bar", view.name !== "catalog" && view.name !== "admin");
    tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.go === view.name));
    if (tg) view.name === "catalog" ? tg.BackButton.hide() : tg.BackButton.show();
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-add],[data-open],[data-go],[data-order],[data-edit],[data-del]");
    if (!t) return;
    if (t.dataset.add) { e.preventDefault(); e.stopPropagation(); return toggle(t.dataset.add); }
    if (t.dataset.open) return go("detail", t.dataset.open);
    if (t.dataset.order) { cart.add(t.dataset.order); saveCart(); return go("order"); }
    if (t.dataset.edit) return go("adminEdit", t.dataset.edit);
    if (t.dataset.del) {
      const ok = () => post("/api/admin/services/delete", { id: t.dataset.del }).then(() => loadCatalogSilently()).then(() => loadAdmin("services")).then(() => go("admin")).catch((er) => showMsg(er.message));
      if (tg && tg.showConfirm) tg.showConfirm("Удалить услугу?", (yes) => yes && ok()); else if (confirm("Удалить услугу?")) ok();
      return;
    }
    if (t.dataset.go) {
      go(t.dataset.go);
      if (t.dataset.go === "admin") loadAdmin("services");
      if (t.dataset.go === "adminOrders") loadAdmin("orders");
    }
  });
  document.addEventListener("submit", (e) => {
    e.preventDefault();
    const formId = e.target.getAttribute("id"); // не e.target.id: поле name="id" внутри формы перекрывает свойство
    if (formId === "orderForm") submit(e.target);
    if (formId === "serviceForm") saveService(e.target);
    if (formId === "settingsForm") {
      post("/api/admin/settings", { settings: Object.fromEntries(new FormData(e.target).entries()) })
        .then((r) => { C = { ...C, ...r.settings }; applySettings(); showMsg("Сохранено", true); })
        .catch((er) => showMsg(er.message));
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.classList.contains("status")) {
      post("/api/admin/orders/status", { id: e.target.dataset.orderId, status: e.target.value }).then(() => showMsg("Статус обновлён", true)).catch((er) => showMsg(er.message));
    }
    if (e.target.name === "icon") document.querySelectorAll(".ico").forEach((l) => l.classList.toggle("on", l.querySelector("input").checked));
  });

  applySettings();
  saveCart();
  render();
  loadCatalog();
})();

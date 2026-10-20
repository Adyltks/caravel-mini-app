/* Caravel Mini App: каталог услуг и пакетов, карточка, заявка-квиз, админ-панель. */
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  const inTg = !!(tg && tg.initData); // открыто внутри Telegram, а не в обычном браузере
  const API = (window.CARAVEL_API || "").replace(/\/$/, "");
  const app = document.getElementById("app");
  const tabs = document.getElementById("tabs");
  const cart = new Set(JSON.parse(sessionStorage.getItem("cart") || "[]"));
  let C = { ...window.CARAVEL, services: window.CARAVEL.services.map((s) => ({ ...s, description: s.desc, kind: "service", category: s.category || "" })) };
  let view = { name: "catalog" };
  let filter = "all";
  let lastOrder = null;
  let isAdmin = false;
  let adminData = { services: [], orders: [] };
  let quiz = { step: 0, niche: "", task: "", budget: "", name: "", phone: "" };
  const STATUS = { new: "Новая", in_progress: "В работе", done: "Выполнена", cancelled: "Отменена" };
  const ICONS = ["ai", "app", "landing", "ads", "bot", "catalog"];
  const CATEGORIES = { web: "Сайты и приложения", ads: "Реклама", ai: "Боты и AI" };
  const NICHES = ["Стоматология", "Косметология", "Окна и двери", "Мебель", "Ремонт", "Другое"];
  const BUDGETS = ["до 30 000", "30–60 000", "60–100 000", "100 000+"];

  if (tg) {
    tg.ready();
    tg.expand();
    tg.setHeaderColor("#0b0b0c");
    tg.setBackgroundColor("#0b0b0c");
    tg.BackButton.onClick(back);
    tg.MainButton.onClick(mainAction);
  }

  const initData = () => (tg ? tg.initData : "");
  const money = (n) => Number(n || 0).toLocaleString("ru-RU") + " " + C.currency;
  const byId = (id) => C.services.find((s) => s.id === id) || adminData.services.find((s) => s.id === id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const icon = (name) => `<svg><use href="#i-${ICONS.includes(name) ? name : "catalog"}"/></svg>`;
  const cover = (name) => `<svg class="mock" viewBox="0 0 160 100"><use href="#m-${ICONS.includes(name) ? name : "catalog"}"/></svg>`;
  const discount = () => Math.min(90, Math.max(0, parseInt(C.pilot_discount, 10) || 0));
  const pilot = (price) => Math.round((price * (100 - discount())) / 100 / 100) * 100;
  const selected = () => [...cart].map(byId).filter(Boolean);

  async function post(path, body) {
    const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, initData: initData() }) });
    const res = await r.json().catch(() => ({}));
    if (!r.ok || !res.ok) throw new Error(res.error || "Ошибка сервера");
    return res;
  }
  async function loadCatalog(silent) {
    if (!API) return;
    try {
      const res = await (await fetch(API + "/api/catalog")).json();
      if (res.ok) { C = { ...C, ...res.settings, services: res.services }; applySettings(); if (!silent) render(); }
    } catch (e) { console.warn("Каталог из services.js:", e.message); }
    if (silent) return;
    try {
      isAdmin = !!(await post("/api/me", {})).admin;
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
    if (view.name === "order" && quiz.step > 0) { quiz.step--; return render(); }
    if (["adminEdit", "adminOrders", "adminSettings"].includes(view.name)) return go("admin");
    go("catalog");
  }

  /* ---------- шапка вложенных экранов ---------- */
  const topbar = (title) => `<div class="topbar"><button class="backbtn" data-back="1" aria-label="Назад">←<span>Назад</span></button><div class="topbar-title">${esc(title || "")}</div></div>`;

  /* ---------- клиентские экраны ---------- */
  function catalog() {
    const all = C.services;
    const packages = all.filter((s) => s.kind === "package");
    const services = all.filter((s) => s.kind !== "package");
    const cats = [...new Set(services.map((s) => s.category).filter(Boolean))];
    const chip = (key, label) => `<button class="fchip ${filter === key ? "on" : ""}" data-filter="${key}">${esc(label)}</button>`;
    const chips = `<div class="fchips">${chip("all", "Все услуги")}${packages.length ? chip("packages", "Пакеты") : ""}${cats.map((c) => chip(c, CATEGORIES[c] || c)).join("")}</div>`;

    const card = (s, big) => `
      <button class="svc fade-in" data-open="${s.id}">
        <div class="cover c-${esc(s.icon)}">${s.badge ? `<span class="badge">${esc(s.badge)}</span>` : ""}${cover(s.icon)}</div>
        <div class="body">
          <div class="t">${esc(s.title)}</div>
          ${big ? `<div class="d">${esc(s.short)}</div>` : ""}
          <div class="row">
            <div><div class="price">от ${money(s.price)}</div>${big ? `<div class="meta">${esc(s.term)}</div>` : ""}</div>
            <span class="plus ${cart.has(s.id) ? "on" : ""}" data-add="${s.id}">${cart.has(s.id) ? "✓" : "+"}</span>
          </div>
        </div>
      </button>`;
    const pkg = (p) => `
      <div class="pkg fade-in ${p.featured ? "hot" : ""}">
        ${p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ""}
        <div class="pkg-head"><div class="pkg-title serif">${esc(p.title)}</div><div class="pkg-price">от ${money(p.price)}<small>${esc(p.term)}</small></div></div>
        <p class="sub">${esc(p.short)}</p>
        ${(p.includes || []).map((x) => `<div class="li"><i>✓</i>${esc(x)}</div>`).join("")}
        <div class="pkg-actions"><button class="btn o" data-open="${p.id}">Подробнее</button><button class="btn g" data-add="${p.id}">${cart.has(p.id) ? "В заявке ✓" : "Выбрать"}</button></div>
      </div>`;

    let body;
    if (filter === "packages") body = packages.map(pkg).join("") || '<div class="empty">Пакеты пока не добавлены.</div>';
    else {
      const list = filter === "all" ? services : services.filter((s) => s.category === filter);
      const featured = list.filter((s) => s.featured);
      const rest = list.filter((s) => !s.featured);
      body = featured.map((s) => card(s, true)).join("") + `<div class="grid">${rest.map((s) => card(s, false)).join("")}</div>`;
      if (!list.length) body = '<div class="empty">В этой категории пока пусто.</div>';
    }
    return `
      <div class="brand serif"><span class="logo">${esc(C.brand[0] || "C")}</span>${esc(C.brand)}</div>
      <div class="eyebrow">${filter === "packages" ? "Готовые решения" : services.length + " услуг под ключ"}</div>
      <h1 class="serif">${filter === "packages" ? "Пакеты <em>под задачу</em>" : "Digital-решения <em>для бизнеса</em>"}</h1>
      <p class="sub">${filter === "packages" ? "Собрали самое нужное в три тарифа. Первому клиенту в нише скидка " + discount() + "%." : "Выберите услуги, узнайте детали и оставьте заявку в пару касаний."}</p>
      ${chips}
      ${body}`;
  }

  function detail(id) {
    const s = byId(id);
    if (!s) return catalog();
    const inCart = cart.has(id);
    const d = discount();
    return `
      ${topbar(s.kind === "package" ? "Пакет" : "Услуга")}
      <div class="hero c-${esc(s.icon)}">${s.badge ? `<span class="badge">${esc(s.badge)}</span>` : ""}${cover(s.icon)}</div>
      <h2 class="serif">${esc(s.title)}</h2>
      <div class="pricebox">
        ${d ? `<div class="old">от ${money(s.price)}</div><div class="now">от ${money(pilot(s.price))}</div><span class="pilot">−${d}% первому клиенту</span>` : `<div class="now">от ${money(s.price)}</div>`}
        ${s.term ? `<div class="meta" style="margin-top:4px">${esc(s.term)}</div>` : ""}
      </div>
      ${C.guarantee ? `<div class="guarantee"><span>🛡</span><span>${esc(C.guarantee)}</span></div>` : ""}
      <p class="sub" style="margin-top:14px">${esc(s.description)}</p>
      ${s.includes && s.includes.length ? `<div class="sec">Что входит</div>${s.includes.map((x) => `<div class="li"><i>✓</i>${esc(x)}</div>`).join("")}` : ""}
      ${s.steps && s.steps.length ? `<div class="sec">Как работаем</div><div class="steps">${s.steps.map((x, i) => `<div class="st"><b class="serif">0${i + 1}</b>${esc(x)}</div>`).join("")}</div>` : ""}
      <div class="bar ${inTg ? "tg-hidden" : ""}">
        <button class="btn o" data-add="${s.id}">${inCart ? "В заявке ✓" : "В заявку +"}</button>
        <button class="btn g" data-order="${s.id}">Оставить заявку</button>
      </div>
      ${inTg ? `<button class="linkbtn" data-add="${s.id}">${inCart ? "Убрать из заявки" : "Добавить в заявку и выбрать ещё"}</button>` : ""}`;
  }

  /* ---------- заявка-квиз ---------- */
  const STEPS = ["Ниша", "Задача", "Контакт"];
  function order() {
    const items = selected();
    if (!items.length) {
      return `${topbar("Заявка")}
        <h1 class="serif">Ваша <em>заявка</em></h1>
        <div class="empty">Вы пока ничего не выбрали.<br>Добавьте услуги из каталога плюсом.</div>
        <div class="bar ${inTg ? "tg-hidden" : ""}"><button class="btn g" data-go="catalog">К услугам</button></div>`;
    }
    const u = (inTg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
    if (!quiz.name && u) quiz.name = [u.first_name, u.last_name].filter(Boolean).join(" ");
    const progress = `<div class="progress">${STEPS.map((t, i) => `<div class="pstep ${i < quiz.step ? "done" : ""} ${i === quiz.step ? "on" : ""}"><b>${i + 1}</b>${t}</div>`).join("")}</div>`;
    const chosen = `<div class="chosen">${items.map((s) => `<span class="tag">${esc(s.title)}<button data-add="${s.id}" aria-label="Убрать">✕</button></span>`).join("")}</div>`;
    const optionChips = (name, list, value, extra) => `<div class="ochips">${list.map((o) => `<button class="ochip ${value === o ? "on" : ""}" data-pick="${name}" data-value="${esc(o)}">${esc(o)}</button>`).join("")}${extra || ""}</div>`;
    let body;
    if (quiz.step === 0) {
      body = `
        <h1 class="serif">В какой вы <em>нише?</em></h1>
        <p class="sub">Так мы сразу покажем похожие кейсы и посчитаем точнее.</p>
        ${optionChips("niche", NICHES, NICHES.includes(quiz.niche) ? quiz.niche : (quiz.niche ? "Другое" : ""))}
        ${quiz.niche && !NICHES.slice(0, -1).includes(quiz.niche) ? `<div class="field"><div class="inp"><input id="nicheInput" placeholder="Напишите, чем занимаетесь" value="${esc(quiz.niche === "Другое" ? "" : quiz.niche)}"></div></div>` : ""}`;
    } else if (quiz.step === 1) {
      body = `
        <h1 class="serif">Какая <em>задача?</em></h1>
        <p class="sub">Пара слов о том, что хотите получить. Бюджет поможет предложить подходящий вариант.</p>
        <div class="field"><div class="inp"><textarea id="taskInput" placeholder="Например: нужны заявки на имплантацию, сейчас только сарафан">${esc(quiz.task)}</textarea></div></div>
        <div class="field"><label>Бюджет, ${esc(C.currency)} в месяц</label>${optionChips("budget", BUDGETS, quiz.budget)}</div>`;
    } else {
      body = `
        <h1 class="serif">Как с вами <em>связаться?</em></h1>
        <p class="sub">${inTg ? "Менеджер напишет в Telegram или позвонит, как удобнее." : "Менеджер позвонит или напишет в WhatsApp или Telegram по этому номеру."}</p>
        <div class="field"><label>Имя</label><div class="inp"><input id="nameInput" value="${esc(quiz.name)}" placeholder="Как к вам обращаться" autocomplete="name">${u ? '<span class="tgtag">из Telegram</span>' : ""}</div></div>
        <div class="field"><label>Телефон</label>
          ${inTg && tg.requestContact ? `<button type="button" class="sharebtn ${quiz.phone ? "done" : ""}" id="shareBtn">${quiz.phone ? "✓ " + esc(quiz.phone) : "Поделиться номером из Telegram"}</button><div class="or">или введите вручную</div>` : ""}
          <input id="websiteInput" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
          <div class="inp" id="phoneBox"><input id="phoneInput" type="tel" inputmode="tel" value="${esc(quiz.phone)}" placeholder="+996 500 000 000" autocomplete="tel"></div>
        </div>
        <div class="note"><span>🔒</span><span>${inTg ? "Заявка сразу придёт менеджеру в Telegram." : "Заявка сразу придёт менеджеру, ответим в течение 15 минут в рабочее время."}${u && u.username ? " Ваш @" + esc(u.username) + " подставим автоматически." : ""}</span></div>`;
    }
    const last = quiz.step === STEPS.length - 1;
    return `${topbar("Заявка · шаг " + (quiz.step + 1) + " из " + STEPS.length)}
      ${progress}
      ${chosen}
      ${body}
      <div class="msg" id="formMsg"></div>
      <div class="bar ${inTg ? "tg-hidden" : ""}"><button class="btn g" data-next="1" id="submitBtn">${last ? "Отправить заявку" : "Далее"}</button></div>`;
  }

  function readStep() {
    const g = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : null; };
    const n = g("nicheInput"); if (n !== null) quiz.niche = n || "Другое";
    const t = g("taskInput"); if (t !== null) quiz.task = t;
    const nm = g("nameInput"); if (nm !== null) quiz.name = nm;
    const p = g("phoneInput"); if (p !== null && p) quiz.phone = p;
    const w = g("websiteInput"); if (w !== null) quiz.website = w;
  }
  async function next() {
    readStep();
    const msg = document.getElementById("formMsg");
    if (quiz.step === 0 && !quiz.niche) return (msg.textContent = "Выберите нишу, можно «Другое».");
    if (quiz.step < STEPS.length - 1) { quiz.step++; window.scrollTo(0, 0); return render(); }
    if (!inTg && !quiz.name) return (msg.textContent = "Укажите имя, чтобы менеджер знал, как к вам обращаться.");
    if (!/^\+?[\d\s()-]{10,18}$/.test(quiz.phone)) {
      document.getElementById("phoneBox").classList.add("err");
      return (msg.textContent = "Укажите телефон, чтобы менеджер мог связаться.");
    }
    await submit();
  }
  async function submit() {
    const payload = { name: quiz.name, phone: quiz.phone, niche: quiz.niche, budget: quiz.budget, comment: quiz.task, website: quiz.website || "", services: [...cart] };
    setMain({ text: "Отправляем…", progress: true });
    const btn = document.getElementById("submitBtn"); if (btn) { btn.disabled = true; btn.textContent = "Отправляем…"; }
    try {
      let res;
      if (API) res = await post("/api/order", payload);
      else if (inTg && tg.sendData) { tg.sendData(JSON.stringify({ ...payload, initData: initData() })); res = { id: "—" }; }
      else res = { id: "DEMO" };
      lastOrder = { id: res.id, name: quiz.name || "—", phone: quiz.phone, services: selected().map((s) => s.title) };
      cart.clear(); saveCart();
      quiz = { step: 0, niche: "", task: "", budget: "", name: "", phone: "" };
      tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred("success");
      go("success");
    } catch (e) {
      const msg = document.getElementById("formMsg");
      if (msg) msg.textContent = "Не удалось отправить: " + e.message + ". Попробуйте ещё раз или напишите менеджеру.";
      if (btn) { btn.disabled = false; btn.textContent = "Отправить заявку"; }
      updateMain();
    }
  }
  function requestPhone() {
    const done = (ok, resp) => {
      const c = resp && resp.responseUnsafe && resp.responseUnsafe.contact;
      if (ok && c && c.phone_number) { quiz.phone = (c.phone_number.startsWith("+") ? "" : "+") + c.phone_number; render(); }
    };
    try { tg.requestContact(done); } catch (e) { console.warn(e); }
  }

  function success() {
    const o = lastOrder;
    return `
      <div class="ok fade-in">
        <div class="ring">${icon("check")}</div>
        <div class="eyebrow" style="margin-top:28px">Заявка №${esc(o.id)}</div>
        <h1 class="serif" style="font-size:32px">Заявка <em>отправлена</em></h1>
        <p class="sub" style="max-width:290px">Менеджер свяжется с вами ${inTg ? "в Telegram" : "по телефону"} в течение 15 минут в рабочее время.</p>
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

  /* ---------- админ-панель ---------- */
  function admin() {
    const list = adminData.services;
    return `${topbar("Админ-панель")}
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
          <div class="grow"><div class="n">${esc(s.title)} ${s.kind === "package" ? '<span class="tgtag">пакет</span>' : ""} ${s.active ? "" : '<span class="tgtag">скрыта</span>'}</div><div class="p">от ${money(s.price)} · ${esc(s.term)}</div></div>
          <button class="abtn sm" data-edit="${s.id}">Изменить</button>
        </div>`).join("")}`;
  }

  function adminEdit(id) {
    const s = id === "new" ? { id: "", title: "", short: "", description: "", price: "", term: "", badge: "", icon: "catalog", featured: false, includes: [], steps: [], sort: 100, active: true, kind: "service", category: "" } : adminData.services.find((x) => x.id === id);
    if (!s) return admin();
    const f = (label, name, value, ph, type) => `<div class="field"><label>${label}</label><div class="inp">${type === "ta" ? `<textarea name="${name}" placeholder="${esc(ph || "")}">${esc(value)}</textarea>` : `<input name="${name}" placeholder="${esc(ph || "")}" value="${esc(value)}">`}</div></div>`;
    return `${topbar(id === "new" ? "Новая услуга" : "Редактирование")}
      <h2 class="serif">${esc(s.title || "Услуга")}</h2>
      <form id="serviceForm" novalidate>
        <input type="hidden" name="id" value="${esc(s.id)}">
        <div class="two">
          <div class="field"><label>Тип</label><div class="inp"><select name="kind"><option value="service" ${s.kind !== "package" ? "selected" : ""}>Услуга</option><option value="package" ${s.kind === "package" ? "selected" : ""}>Пакет</option></select></div></div>
          <div class="field"><label>Категория</label><div class="inp"><select name="category"><option value="">Без категории</option>${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}" ${s.category === k ? "selected" : ""}>${v}</option>`).join("")}</select></div></div>
        </div>
        ${f("Название", "title", s.title, "Например, SEO-продвижение")}
        ${f("Коротко (в каталоге)", "short", s.short, "Одна фраза о выгоде")}
        ${f("Описание", "description", s.description, "Подробно, что получает клиент", "ta")}
        <div class="two">${f("Цена от", "price", s.price, "50000")}${f("Срок / период", "term", s.term, "1–2 недели")}</div>
        <div class="two">${f("Метка", "badge", s.badge || "", "ХИТ / НОВОЕ")}${f("Порядок", "sort", s.sort, "100")}</div>
        <div class="field"><label>Обложка</label><div class="icons">${ICONS.map((i) => `<label class="ico ${s.icon === i ? "on" : ""}"><input type="radio" name="icon" value="${i}" ${s.icon === i ? "checked" : ""}>${icon(i)}</label>`).join("")}</div></div>
        ${f("Что входит (каждый пункт с новой строки)", "includes", (s.includes || []).join("\n"), "Аудит\nДизайн\nЗапуск", "ta")}
        ${f("Этапы (через запятую)", "steps", (s.steps || []).join(", "), "Бриф, Дизайн, Запуск")}
        <label class="check"><input type="checkbox" name="featured" ${s.featured ? "checked" : ""}> Показывать большой карточкой наверху</label>
        <label class="check"><input type="checkbox" name="active" ${s.active ? "checked" : ""}> Показывать клиентам</label>
        <div class="msg" id="adminMsg"></div>
        ${id !== "new" ? `<button type="button" class="abtn danger" data-del="${esc(s.id)}">Удалить</button>` : ""}
        <div class="bar"><button class="btn o" type="button" data-go="admin">Отмена</button><button class="btn g" type="submit" id="saveBtn">Сохранить</button></div>
      </form>`;
  }

  function adminOrders() {
    const list = adminData.orders;
    return `${topbar("Админ-панель")}
      <h1 class="serif">Заявки <em>${list.length}</em></h1>
      <div class="msg" id="adminMsg"></div>
      ${list.length ? "" : '<div class="empty">Заявок пока нет.</div>'}
      ${list.map((o) => `
        <div class="ticket" style="margin-top:12px">
          <div class="tr"><span>№${esc(o.id)}</span><div>${new Date(o.created_at).toLocaleString("ru-RU")}</div></div>
          <div class="tr"><span>Клиент</span><div style="text-align:right">${esc(o.name)} ${o.username ? esc(o.username) : ""}<br><a href="tel:${esc(o.phone)}" style="color:var(--gold)">${esc(o.phone)}</a></div></div>
          <div class="tr"><span>Услуги</span><div style="text-align:right">${(o.services || []).map(esc).join(", ")}</div></div>
          ${o.niche ? `<div class="tr"><span>Ниша</span><div>${esc(o.niche)}</div></div>` : ""}
          ${o.budget ? `<div class="tr"><span>Бюджет</span><div>${esc(o.budget)}</div></div>` : ""}
          ${o.comment ? `<div class="tr"><span>Задача</span><div style="text-align:right">${esc(o.comment)}</div></div>` : ""}
          <div class="tr"><span>Статус</span><select class="status" data-order-id="${esc(o.id)}">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${o.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        </div>`).join("")}
      <div class="bar"><button class="btn o" data-go="admin">Назад</button></div>`;
  }

  function adminSettings() {
    return `${topbar("Админ-панель")}
      <h1 class="serif">Настройки</h1>
      <form id="settingsForm" novalidate>
        <div class="field"><label>Название бренда</label><div class="inp"><input name="brand" value="${esc(C.brand)}"></div></div>
        <div class="field"><label>Валюта</label><div class="inp"><input name="currency" value="${esc(C.currency)}" placeholder="сом"></div></div>
        <div class="field"><label>Ссылка «Написать менеджеру»</label><div class="inp"><input name="manager" value="${esc(C.manager)}" placeholder="https://t.me/username"></div></div>
        <div class="field"><label>Скидка первому клиенту, % (0 = не показывать)</label><div class="inp"><input name="pilot_discount" inputmode="numeric" value="${esc(C.pilot_discount || 0)}"></div></div>
        <div class="field"><label>Текст гарантии в карточке (пусто = не показывать)</label><div class="inp"><textarea name="guarantee">${esc(C.guarantee || "")}</textarea></div></div>
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
    const el = document.getElementById("adminMsg") || document.getElementById("formMsg");
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
      await loadCatalog(true);
      adminData.services = (await post("/api/admin/services", {})).services;
      go("admin");
    } catch (e) { showMsg(e.message); btn.disabled = false; }
  }

  /* ---------- нативные кнопки Telegram ---------- */
  function setMain(p) {
    if (!inTg) return;
    if (!p) return tg.MainButton.hide();
    tg.MainButton.setParams({ text: p.text, color: "#e2b956", text_color: "#111111", is_visible: true, is_active: !p.progress });
    p.progress ? tg.MainButton.showProgress() : tg.MainButton.hideProgress();
  }
  function updateMain() {
    const n = cart.size;
    const plural = n === 1 ? "услуга" : n < 5 ? "услуги" : "услуг";
    if (view.name === "catalog") return setMain(n ? { text: `Оставить заявку · ${n} ${plural}` } : null);
    if (view.name === "detail") return setMain({ text: cart.has(view.arg) ? `Оставить заявку · ${n} ${plural}` : "Оставить заявку" });
    if (view.name === "order") return setMain(cart.size ? { text: quiz.step === STEPS.length - 1 ? "Отправить заявку" : "Далее" } : { text: "К услугам" });
    if (view.name === "success") return setMain({ text: "Вернуться к услугам" });
    setMain(null);
  }
  function mainAction() {
    if (view.name === "detail") { cart.add(view.arg); saveCart(); return go("order"); }
    if (view.name === "catalog") return go("order");
    if (view.name === "order") return cart.size ? next() : go("catalog");
    if (view.name === "success") return go("catalog");
  }

  /* ---------- рендер ---------- */
  const screens = { catalog, order, success, admin, adminOrders, adminSettings };
  function render() {
    app.innerHTML = screens[view.name] ? screens[view.name]() : view.name === "adminEdit" ? adminEdit(view.arg) : detail(view.arg);
    const nested = view.name !== "catalog";
    document.body.classList.toggle("has-bar", nested && view.name !== "admin");
    document.body.classList.toggle("nested", nested);
    tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.go === view.name));
    if (tg) nested ? tg.BackButton.show() : tg.BackButton.hide();
    updateMain();
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-add],[data-open],[data-go],[data-order],[data-edit],[data-del],[data-back],[data-filter],[data-pick],[data-next],#shareBtn");
    if (!t) return;
    if (t.dataset.add) { e.preventDefault(); e.stopPropagation(); return toggle(t.dataset.add); }
    if (t.dataset.back) return back();
    if (t.dataset.filter) { filter = t.dataset.filter; return render(); }
    if (t.dataset.pick) { readStep(); quiz[t.dataset.pick] = t.dataset.value; return render(); }
    if (t.dataset.next) return next();
    if (t.id === "shareBtn") return requestPhone();
    if (t.dataset.open) return go("detail", t.dataset.open);
    if (t.dataset.order) { cart.add(t.dataset.order); saveCart(); return go("order"); }
    if (t.dataset.edit) return go("adminEdit", t.dataset.edit);
    if (t.dataset.del) {
      const ok = () => post("/api/admin/services/delete", { id: t.dataset.del }).then(() => loadCatalog(true)).then(() => loadAdmin("services")).then(() => go("admin")).catch((er) => showMsg(er.message));
      if (inTg && tg.showConfirm) tg.showConfirm("Удалить?", (yes) => yes && ok()); else if (confirm("Удалить?")) ok();
      return;
    }
    if (t.dataset.go) {
      if (t.dataset.go === "order") quiz.step = 0;
      go(t.dataset.go);
      if (t.dataset.go === "admin") loadAdmin("services");
      if (t.dataset.go === "adminOrders") loadAdmin("orders");
    }
  });
  document.addEventListener("submit", (e) => {
    e.preventDefault();
    const formId = e.target.getAttribute("id"); // не e.target.id: поле name="id" внутри формы перекрывает свойство
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
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && view.name !== "catalog") back(); });

  applySettings();
  saveCart();
  render();
  loadCatalog();
})();

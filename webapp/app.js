/* Caravel Mini App в стиле «Дордой»: прилавок услуг, пакеты-торг, карточка на весах, заявка-объявление, админ-панель. */
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  const inTg = !!(tg && tg.initData); // открыто внутри Telegram, а не в обычном браузере
  const API = (window.CARAVEL_API || "").replace(/\/$/, "");
  const app = document.getElementById("app");
  const tabs = document.getElementById("tabs");
  const cart = new Set(JSON.parse(sessionStorage.getItem("cart") || "[]"));
  let C = { ...window.CARAVEL, services: window.CARAVEL.services.map((s) => ({ ...s, description: s.desc, kind: "service", category: s.category || "" })) };
  let view = { name: "catalog" };
  let pickedPkg = null;
  let lastOrder = null;
  let isAdmin = false;
  let adminData = { services: [], orders: [] };
  let quiz = { niche: "", task: "", name: "", phone: "", website: "" };
  const STATUS = { new: "Новая", in_progress: "В работе", done: "Выполнена", cancelled: "Отменена" };
  const ICONS = ["ai", "app", "landing", "ads", "bot", "catalog"];
  const CATEGORIES = { web: "Сайты и приложения", ads: "Реклама", ai: "Боты и AI" };
  const NICHES = ["Стоматология", "Косметология", "Окна, двери", "Мебель", "Ремонт", "Другое"];
  const TILT = ["-3deg", "2.5deg", "1.5deg", "-2deg", "2deg", "-1.5deg"];

  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor("#0f3b38"); tg.setBackgroundColor("#0f3b38"); tg.setBottomBarColor && tg.setBottomBarColor("#0f3b38"); } catch {}
    tg.BackButton.onClick(back);
    tg.MainButton.onClick(mainAction);
  }

  const initData = () => (tg ? tg.initData : "");
  const num = (n) => Number(n || 0).toLocaleString("ru-RU");
  const money = (n) => num(n) + " " + C.currency;
  const byId = (id) => C.services.find((s) => s.id === id) || adminData.services.find((s) => s.id === id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const icon = (name) => `<svg><use href="#i-${ICONS.includes(name) ? name : "catalog"}"/></svg>`;
  const discount = () => Math.min(90, Math.max(0, parseInt(C.pilot_discount, 10) || 0));
  const pilot = (price) => Math.round((price * (100 - discount())) / 100 / 100) * 100;
  const now = (s) => (discount() ? pilot(s.price) : s.price); // цена, которую видит клиент
  const selected = () => [...cart].map(byId).filter(Boolean);
  const services = () => C.services.filter((s) => s.kind !== "package");
  const packages = () => C.services.filter((s) => s.kind === "package");
  const strike = `<svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d="M2 20 C 30 8, 60 22, 98 6"/></svg>`;
  const unit = (term) => { const t = String(term || "").trim(); if (/^(в месяц|ежемесяч)/i.test(t)) return "в месяц"; return t.length <= 14 ? t : t.split(/[,(]/)[0].trim(); };

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
  const history = [];
  function go(name, arg, isBack) {
    if (!isBack && view.name !== name) history.push(view);
    view = { name, arg };
    window.scrollTo(0, 0);
    render();
  }
  function back() {
    if (["adminEdit", "adminOrders", "adminSettings"].includes(view.name)) return go("admin", null, true);
    if (view.name === "success") { history.length = 0; return go("catalog", null, true); }
    const prev = history.pop();
    go(prev && prev.name !== "success" ? prev.name : "catalog", prev && prev.arg, true);
  }
  const topbar = (right) => `<div class="top"><button class="backbtn" data-back="1">← Назад</button><span>${esc(right || "")}</span></div>`;

  /* ---------- 1 · прилавок ---------- */
  function catalog() {
    const list = services();
    const sign = (s, i) => `
      <button class="sign kraft torn ${s.featured ? "hot" : ""}" style="--r:${TILT[i % TILT.length]};--i:${i}" data-open="${esc(s.id)}">
        ${cart.has(s.id) ? '<span class="in">в заявке</span>' : ""}
        <small>${esc(s.title)}</small><b>${num(now(s))}</b><i>${esc(C.currency)} · ${esc(unit(s.term))}</i>
        ${s.featured || s.badge ? `<em>${esc(s.badge ? s.badge.toLowerCase() : "ходовое")}</em>` : ""}
      </button>`;
    return `
      <div class="top"><b>${esc(C.brand)}</b><span>Бишкек</span></div>
      <h1>Цены пишем<br><span class="hl">на картонке</span></h1>
      <p class="lead">Реклама, страницы и боты для бизнеса. <b>Без «позвоните — узнаете».</b> Нажмите на ценник.</p>
      <div class="stall">${list.map(sign).join("") || '<div class="empty">Скоро здесь появятся услуги.</div>'}</div>
      ${C.guarantee ? `<div class="promise hand">Нет заявок за месяц — вернём оплату<svg viewBox="0 0 300 12" preserveAspectRatio="none"><path d="M2 8 C 60 2, 120 11, 180 5 S 270 3, 298 7"/></svg></div>` : ""}
      <div class="bar ${inTg ? "tg-hidden" : ""}"><button class="btn" data-go="order">${cart.size ? "Оставить заявку · " + cart.size : "Посчитать для моего бизнеса"}</button></div>`;
  }

  /* ---------- 2 · пакеты: торг ---------- */
  function pkgs() {
    const list = packages();
    if (!pickedPkg || !list.find((p) => p.id === pickedPkg)) pickedPkg = (list.find((p) => p.featured) || list[0] || {}).id;
    const d = discount();
    const row = (p, i) => `
      <button class="pk ${p.id === pickedPkg ? "on" : ""}" style="--r:${["-1deg", ".8deg", "-.6deg"][i % 3]};--i:${i}" data-pkg="${esc(p.id)}">
        <h3>${esc(p.title)}</h3><p>${esc(p.short)}</p>
        <div class="pr">${d ? `<span class="old">${num(p.price)}${strike}</span>` : ""}<span class="new">${num(now(p))}<small>${esc(unit(p.term))}</small></span></div>
      </button>`;
    const pick = byId(pickedPkg);
    return `
      <div class="top"><b>Пакеты</b><span>${list.length} на прилавке</span></div>
      <div class="torg">Торгу&shy;емся<span>?</span></div>
      ${d ? `<div class="hand">Уже уступили: первому в нише −${d}%.</div>` : ""}
      ${list.map(row).join("") || '<div class="empty">Пакеты пока не добавлены.</div>'}
      ${pick ? `<button class="linkbtn" data-open="${esc(pick.id)}">Что входит в «${esc(pick.title)}»</button>` : ""}
      <p class="fine">Рекламный бюджет оплачивается отдельно, напрямую в Instagram. ${esc(C.guarantee || "")}</p>
      ${pick ? `<div class="bar ${inTg ? "tg-hidden" : ""}"><button class="btn" data-order="${esc(pick.id)}">Беру «${esc(pick.title)}»</button></div>` : ""}`;
  }

  /* ---------- 3 · карточка на весах ---------- */
  function scaleSvg(s) {
    const items = (s.includes || []).slice(0, 4).map((x) => (x.length > 22 ? x.slice(0, 21) + "…" : x)).sort((a, b) => b.length - a.length);
    const wts = items.map((t, i) => { const w = Math.min(156, t.length * 7.4 + 22); return `<rect x="${82 - w / 2}" y="${170 - i * 26}" width="${w}" height="24" rx="3"/><text x="82" y="${188 - i * 26}">${esc(t)}</text>`; }).join("");
    const tag = num(now(s)); const tw = tag.length * 13 + 26;
    return `<svg class="scale" viewBox="0 0 360 250" role="img" aria-label="Весы: что входит и цена">
      <path class="st" d="M180 46 V 228 M140 232 H220" style="stroke-width:3"/>
      <g class="beam"><path class="st" d="M82 46 H278" style="stroke-width:4"/><circle cx="180" cy="46" r="6" fill="var(--yel)"/></g>
      <g class="pl"><path class="st" d="M82 46 L10 196 M82 46 L154 196"/><path d="M2 196 Q82 224 162 196 Z" fill="var(--paper)"/><g class="w">${wts}</g></g>
      <g class="pr"><path class="st" d="M278 46 L228 196 M278 46 L328 196"/><path d="M220 196 Q278 222 336 196 Z" fill="var(--paper)"/>
        <g transform="rotate(-4 278 170)"><rect class="tagr" x="${278 - tw / 2}" y="146" width="${tw}" height="50" rx="3"/><text class="tagt" x="278" y="181">${tag}</text></g></g>
      <text class="ok" x="180" y="22">весит честно</text></svg>`;
  }
  function detail(id) {
    const s = byId(id);
    if (!s) return catalog();
    const d = discount();
    const inCart = cart.has(id);
    const isPkg = s.kind === "package";
    const all = services();
    const n = all.indexOf(s);
    return `
      ${topbar(isPkg ? "пакет" : n >= 0 ? "ценник " + (n + 1) + " из " + all.length : "услуга")}
      <h2>${esc(s.title)}</h2>
      ${scaleSvg(s)}
      <div class="svcp"><b>${money(now(s))}</b>${d ? `<s>${num(s.price)}</s><em>−${d}% первому в нише</em>` : ""}</div>
      <div class="lead" style="margin:0">${esc(s.term || "")}</div>
      ${C.guarantee ? `<div class="guar">${esc(C.guarantee)}</div>` : ""}
      ${s.description ? `<p class="desc">${esc(s.description)}</p>` : ""}
      ${s.includes && s.includes.length ? `<div class="sec">Что лежит на весах</div><ul class="inc">${s.includes.map((x, i) => `<li style="--i:${i}"><span>${i + 1}</span>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${s.steps && s.steps.length ? `<div class="sec">Как работаем</div><div class="path">${s.steps.map(esc).join(" · ")}</div>` : ""}
      <button class="linkbtn" data-add="${esc(s.id)}">${inCart ? "Убрать из заявки" : "Добавить в заявку и выбрать ещё"}</button>
      <div class="bar ${inTg ? "tg-hidden" : ""}"><button class="btn" data-order="${esc(s.id)}">Беру · ${esc(s.title)}</button></div>`;
  }

  /* ---------- 4 · заявка-объявление ---------- */
  function order() {
    const items = selected();
    const u = (inTg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
    if (!quiz.name && u) quiz.name = [u.first_name, u.last_name].filter(Boolean).join(" ");
    const other = quiz.niche && !NICHES.slice(0, -1).includes(quiz.niche);
    return `
      ${topbar("заявка")}
      <div class="notice">
        <div class="tape l"></div><div class="tape r"></div>
        <h2>Нужны<br><span>клиенты?</span></h2>
        <div class="chosen">${items.length ? "Вы берёте: " + items.map((s) => `<span class="tag">${esc(s.title)}<button data-add="${esc(s.id)}" aria-label="Убрать">✕</button></span>`).join("") : "Пока ничего не выбрано."} <button class="add" data-go="catalog">${items.length ? "добавить" : "к прилавку"}</button></div>
        <div class="f" id="nameBox"><label for="nameInput">Имя</label><input id="nameInput" value="${esc(quiz.name)}" placeholder="Как к вам обращаться" autocomplete="name"></div>
        <div class="f" id="phoneBox"><label for="phoneInput">Телефон</label><input id="phoneInput" type="tel" inputmode="tel" value="${esc(quiz.phone)}" placeholder="+996 ___ __ __ __" autocomplete="tel"></div>
        ${inTg && tg.requestContact ? `<button type="button" class="tgl ${quiz.phone ? "done" : ""}" id="shareBtn">${quiz.phone ? "Номер взяли из Telegram" : "Взять номер из Telegram"}</button>` : ""}
        <div class="f"><label for="taskInput">Задача</label><input id="taskInput" value="${esc(quiz.task)}" placeholder="по желанию"></div>
        <input id="websiteInput" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
        ${other ? `<div class="f"><label for="nicheInput">Ниша</label><input id="nicheInput" value="${esc(quiz.niche === "Другое" ? "" : quiz.niche)}" placeholder="чем занимаетесь"></div>` : ""}
        <div class="msg" id="formMsg"></div>
        <div class="ask">Ваша ниша — оторвите листок:</div>
        <div class="fringe">${NICHES.map((n, i) => `<button class="tab-off ${quiz.niche === n || (n === "Другое" && other) ? "on" : ""}" style="--tr:${i % 2 ? "-5deg" : "5deg"}" data-pick="niche" data-value="${esc(n)}"><span>${esc(n)}</span></button>`).join("")}</div>
      </div>
      <p class="priv">Имя и телефон видит только наш менеджер. Используем их, чтобы связаться по заявке, без рассылок.</p>
      <div class="bar ${inTg ? "tg-hidden" : ""}"><button class="btn" data-next="1" id="submitBtn">Отправить заявку</button></div>`;
  }
  function readStep() {
    const g = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : null; };
    const n = g("nicheInput"); if (n !== null) quiz.niche = n || "Другое";
    const t = g("taskInput"); if (t !== null) quiz.task = t;
    const nm = g("nameInput"); if (nm !== null) quiz.name = nm;
    const p = g("phoneInput"); if (p !== null) quiz.phone = p;
    const w = g("websiteInput"); if (w !== null) quiz.website = w;
  }
  async function next() {
    readStep();
    const msg = document.getElementById("formMsg");
    const bad = (box, text) => { const b = document.getElementById(box); if (b) b.classList.add("err"); msg.textContent = text; };
    if (!cart.size) return (msg.textContent = "Выберите услугу или пакет на прилавке.");
    if (!quiz.name) return bad("nameBox", "Напишите имя");
    if (!/^\+?[\d\s()-]{9,18}$/.test(quiz.phone)) return bad("phoneBox", "Напишите телефон");
    if (!quiz.niche) return (msg.textContent = "Оторвите листок с вашей нишей");
    await submit();
  }
  async function submit() {
    const payload = { name: quiz.name, phone: quiz.phone, niche: quiz.niche, budget: "", comment: quiz.task, website: quiz.website || "", services: [...cart] };
    setMain({ text: "Отправляем…", progress: true });
    const btn = document.getElementById("submitBtn"); if (btn) { btn.disabled = true; btn.textContent = "Отправляем…"; }
    try {
      let res;
      if (API) res = await post("/api/order", payload);
      else res = { id: "DEMO" };
      lastOrder = { id: res.id, name: quiz.name, phone: quiz.phone, niche: quiz.niche, services: selected().map((s) => s.title) };
      cart.clear(); saveCart();
      quiz = { niche: "", task: "", name: "", phone: "", website: "" };
      history.length = 0;
      tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred("success");
      go("success");
    } catch (e) {
      const msg = document.getElementById("formMsg");
      if (msg) msg.textContent = "Не ушло: " + e.message + ". Попробуйте ещё раз или напишите нам.";
      if (btn) { btn.disabled = false; btn.textContent = "Отправить заявку"; }
      updateMain();
    }
  }
  function requestPhone() {
    readStep();
    const done = (ok, resp) => {
      const c = resp && resp.responseUnsafe && resp.responseUnsafe.contact;
      if (ok && c && c.phone_number) { quiz.phone = (c.phone_number.startsWith("+") ? "" : "+") + c.phone_number; render(); }
    };
    try { tg.requestContact(done); } catch (e) { console.warn(e); }
  }

  /* ---------- 5 · табличка «Ушли звонить вам» ---------- */
  function success() {
    const o = lastOrder || { id: "—", name: "", phone: "", niche: "", services: [] };
    return `
      <div class="top"><b>${esc(C.brand)}</b><span>заявка № ${esc(o.id)}</span></div>
      <div class="nail"><div class="board">
        <svg viewBox="0 0 342 70" preserveAspectRatio="none" aria-hidden="true"><path d="M171 0 L70 70 M171 0 L272 70"/></svg>
        <div class="plate kraft torn"><small>Перерыв 15 минут</small><b>Ушли<br><span>звонить вам</span></b><i>${inTg ? "напишем в Telegram или позвоним" : "сейчас вернёмся с ответом"}</i></div>
      </div></div>
      <div class="slip"><h4><span>Записали</span><span>№ ${esc(o.id)}</span></h4><p>${o.services.map(esc).join(", ")}${o.niche ? " · " + esc(o.niche) : ""}<br>${esc(o.name)} · ${esc(o.phone)}</p></div>
      <p class="steps3"><b>Созвон 15 минут</b> в рабочее время, потом <b>бесплатный аудит</b> за 2 дня и <b>первые заявки</b> за 14 дней.</p>
      <button class="linkbtn" data-go="catalog">Вернуться к прилавку</button>
      <div class="bar"><a class="btn o" href="${esc(C.manager)}" target="_blank" rel="noopener">Написать нам сейчас</a></div>`;
  }

  /* ---------- админ-панель ---------- */
  function admin() {
    const list = adminData.services;
    return `${topbar("админ")}
      <h1>Прилавок <span class="hl">${list.length}</span></h1>
      <p class="admin-note">В поле «Цена от» пишите обычную цену. Если в настройках стоит скидка первому клиенту, приложение само зачеркнёт эту цену и покажет цену со скидкой.</p>
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
    return `${topbar(id === "new" ? "новая услуга" : "редактирование")}
      <h2>${esc(s.title || "Услуга")}</h2>
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
    return `${topbar("админ")}
      <h1>Заявки <span class="hl">${list.length}</span></h1>
      <div class="msg" id="adminMsg"></div>
      ${list.length ? "" : '<div class="empty">Заявок пока нет.</div>'}
      ${list.map((o) => `
        <div class="ticket" style="margin-top:12px">
          <div class="tr"><span>№${esc(o.id)}</span><div>${new Date(o.created_at).toLocaleString("ru-RU")}</div></div>
          <div class="tr"><span>Клиент</span><div style="text-align:right">${esc(o.name)} ${o.username ? esc(o.username) : ""}<br><a href="tel:${esc(o.phone)}" >${esc(o.phone)}</a></div></div>
          <div class="tr"><span>Услуги</span><div style="text-align:right">${(o.services || []).map(esc).join(", ")}</div></div>
          ${o.niche ? `<div class="tr"><span>Ниша</span><div>${esc(o.niche)}</div></div>` : ""}
          ${o.budget ? `<div class="tr"><span>Бюджет</span><div>${esc(o.budget)}</div></div>` : ""}
          ${o.comment ? `<div class="tr"><span>Задача</span><div style="text-align:right">${esc(o.comment)}</div></div>` : ""}
          <div class="tr"><span>Статус</span><select class="status" data-order-id="${esc(o.id)}">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${o.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        </div>`).join("")}
      <div class="bar"><button class="btn o" data-go="admin">Назад</button></div>`;
  }

  function adminSettings() {
    return `${topbar("админ")}
      <h1>Настройки</h1>
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
    if (el) { el.textContent = text; el.style.color = ok ? "var(--yel)" : ""; }
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
    tg.MainButton.setParams({ text: p.text, color: "#ff6a2b", text_color: "#ffffff", is_visible: true, is_active: !p.progress });
    p.progress ? tg.MainButton.showProgress() : tg.MainButton.hideProgress();
  }
  function updateMain() {
    const n = cart.size;
    if (view.name === "catalog") return setMain({ text: n ? "Оставить заявку · " + n : "Посчитать для моего бизнеса" });
    if (view.name === "packages") { const p = byId(pickedPkg); return setMain(p ? { text: "Беру «" + p.title + "»" } : null); }
    if (view.name === "detail") { const s = byId(view.arg); return setMain(s ? { text: "Беру · " + s.title } : null); }
    if (view.name === "order") return setMain({ text: "Отправить заявку" });
    if (view.name === "success") return setMain({ text: "Написать нам сейчас" });
    setMain(null);
  }
  function mainAction() {
    if (view.name === "catalog") return go("order");
    if (view.name === "packages") { if (pickedPkg) { cart.add(pickedPkg); saveCart(); } return go("order"); }
    if (view.name === "detail") { cart.add(view.arg); saveCart(); return go("order"); }
    if (view.name === "order") return next();
    if (view.name === "success") return tg.openTelegramLink && /^https:\/\/t\.me\//.test(C.manager) ? tg.openTelegramLink(C.manager) : tg.openLink(C.manager);
  }

  /* ---------- рендер ---------- */
  const screens = { catalog, packages: pkgs, order, success, admin, adminOrders, adminSettings };
  function render() {
    app.innerHTML = screens[view.name] ? screens[view.name]() : view.name === "adminEdit" ? adminEdit(view.arg) : detail(view.arg);
    const nested = !["catalog", "packages", "success"].includes(view.name);
    document.body.classList.toggle("has-bar", !!app.querySelector(".bar:not(.tg-hidden)"));
    tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.go === view.name || (view.name === "detail" && t.dataset.go === "catalog") || (view.name === "success" && t.dataset.go === "order") || (view.name.startsWith("admin") && t.dataset.go === "admin")));
    if (tg) nested ? tg.BackButton.show() : tg.BackButton.hide();
    updateMain();
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-add],[data-open],[data-go],[data-order],[data-edit],[data-del],[data-back],[data-pkg],[data-pick],[data-next],#shareBtn");
    if (!t) return;
    if (t.dataset.add) { e.preventDefault(); e.stopPropagation(); return toggle(t.dataset.add); }
    if (t.dataset.back) return back();
    if (t.dataset.pkg) { pickedPkg = t.dataset.pkg; tg && tg.HapticFeedback && tg.HapticFeedback.selectionChanged(); app.querySelectorAll(".pk").forEach((x) => x.classList.toggle("on", x === t)); const b = app.querySelector(".bar .btn"); const p = byId(pickedPkg); if (b && p) { b.dataset.order = p.id; b.textContent = "Беру «" + p.title + "»"; } const l = app.querySelector(".linkbtn"); if (l && p) { l.dataset.open = p.id; l.textContent = "Что входит в «" + p.title + "»"; } return updateMain(); }
    if (t.dataset.pick) { readStep(); quiz[t.dataset.pick] = t.dataset.value; tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred("medium"); return render(); }
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
      if (view.name === "order") readStep();
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
  document.addEventListener("input", (e) => { const f = e.target.closest(".f.err"); if (f) f.classList.remove("err"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && view.name !== "catalog") back(); });

  /* для скриншотов: ?screen=packages|detail:ads|order|success */
  if (new URLSearchParams(location.search).has("still")) document.documentElement.classList.add("still");
  const q = new URLSearchParams(location.search).get("screen");
  if (q) { const [n, a] = q.split(":"); if (n === "success") lastOrder = { id: 1007, name: "Адука", phone: "+996 555 12 34 56", niche: "Стоматология", services: ["Поток клиентов"] }; if (n === "order") { cart.add("flow"); quiz.name = "Адука"; quiz.niche = "Стоматология"; } view = { name: n, arg: a }; }

  applySettings();
  saveCart();
  render();
  loadCatalog();
})();

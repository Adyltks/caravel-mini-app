/* Мини апп Aduka AI: услуги, пакеты, карточка услуги, заявка, чат с ИИ-помощником и админ-панель.
   Стиль как на лендинге aduka.ai. Всё из API вставляется через esc() или textContent. */
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  const inTg = !!(tg && tg.initData); // открыто внутри Telegram, а не в обычном браузере
  const API = (window.CARAVEL_API || "").replace(/\/$/, "");
  const BOT_URL = "https://t.me/AdukaMarketing_bot"; // бот для чата вне Telegram
  const GREETING = "Здравствуйте! Я помощник Aduka AI. Расскажите, чем занимается ваш бизнес, и я подскажу, что поможет получать больше заявок.";
  const CHAT_MAX = 1000;
  const CHAT_TIMEOUT = 45000; // ответ ИИ идёт 5–20 секунд, ждём с запасом
  const CHAT_ERR = {
    rate_limited: "Слишком много сообщений подряд. Подождите минуту и попробуйте ещё раз.",
    forbidden: "Чат работает только внутри Telegram. Откройте мини апп из бота.",
    default: "Не получилось отправить, попробуйте ещё раз.",
  };
  const COLORS = { violet: "#5B3FF5", lilac: "#F4F2FF", white: "#FFFFFF" };
  const app = document.getElementById("app");
  const tabs = document.getElementById("tabs");

  // sessionStorage может быть недоступен (приватный режим, встроенные браузеры) — всё в try/catch
  const store = {
    get(k, d) { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const cart = new Set(store.get("cart", []));
  let C = { ...window.CARAVEL, services: window.CARAVEL.services.map((s) => ({ ...s, description: s.desc, kind: "service", category: s.category || "" })) };
  let view = { name: "catalog" };
  let pickedPkg = null;
  let lastOrder = null;
  let isAdmin = false;
  let adminData = { services: [], orders: [] };
  let quiz = { niche: "", task: "", name: "", phone: "", website: "" };
  // чат: сообщения, черновик, флаги загрузки и отправки
  const chat = { msgs: [], greet: true, loading: false, sending: false, draft: "", error: "" };
  const STATUS = { new: "Новая", in_progress: "В работе", done: "Выполнена", cancelled: "Отменена" };
  const ICONS = ["ai", "app", "landing", "ads", "bot", "catalog"];
  const CATEGORIES = { web: "Сайты и приложения", ads: "Реклама", ai: "Боты и AI" };
  const NICHES = ["Стоматология", "Косметология", "Окна, двери", "Мебель", "Ремонт", "Другое"];
  const PASTEL = ["lavender", "peach", "mint", "butter"];

  if (tg) {
    tg.ready();
    tg.expand();
    // цвета шапки и низа Telegram под палитру aduka.ai (старые клиенты не умеют — молча пропускаем)
    try { tg.setHeaderColor(COLORS.violet); tg.setBackgroundColor(COLORS.lilac); tg.setBottomBarColor && tg.setBottomBarColor(COLORS.white); } catch {}
    tg.BackButton.onClick(back);
    tg.MainButton.onClick(mainAction);
    try { tg.onEvent("viewportChanged", onViewport); } catch {}
  }

  const initData = () => (tg ? tg.initData : "");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => Number(n || 0).toLocaleString("ru-RU");
  const money = (n) => esc(num(n) + " " + C.currency);
  const safeUrl = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || "").trim()) ? String(u).trim() : ""); // только https
  const byId = (id) => C.services.find((s) => s.id === id) || adminData.services.find((s) => s.id === id);
  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${ICONS.includes(name) ? name : "catalog"}"/></svg>`;
  const discount = () => Math.min(90, Math.max(0, parseInt(C.pilot_discount, 10) || 0));
  const pilot = (price) => Math.round((price * (100 - discount())) / 100 / 100) * 100;
  const now = (s) => (discount() ? pilot(s.price) : s.price); // цена, которую видит клиент
  const selected = () => [...cart].map(byId).filter(Boolean);
  const services = () => C.services.filter((s) => s.kind !== "package");
  const packages = () => C.services.filter((s) => s.kind === "package");
  const unit = (term) => { const t = String(term || "").trim(); if (/^(в месяц|ежемесяч)/i.test(t)) return "в месяц"; return t.length <= 14 ? t : t.split(/[,(]/)[0].trim(); };
  const logo = (white) => `<img src="images/logo-${white ? "white" : "color"}.png" alt="" width="52" height="28">`;
  const haptic = (kind, arg) => { try { tg && tg.HapticFeedback && tg.HapticFeedback[kind](arg); } catch {} };

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
      if (res.ok) { C = { ...C, ...res.settings, services: res.services }; if (!silent && view.name !== "chat") render(); }
    } catch (e) { console.warn("Каталог из services.js:", e.message); }
    if (silent) return;
    try {
      isAdmin = !!(await post("/api/me", {})).admin;
      document.getElementById("adminTab").hidden = !isAdmin;
    } catch {}
  }

  function saveCart() {
    store.set("cart", [...cart]);
    const el = document.getElementById("cartCount");
    el.textContent = cart.size;
    el.hidden = cart.size === 0;
  }
  function toggle(id) {
    cart.has(id) ? cart.delete(id) : cart.add(id);
    haptic("impactOccurred", "light");
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
  // шапка вложенного экрана: «Назад», подпись справа, заголовок
  const subhead = (label, title, lead) => `
    <header class="head sm"><div class="in">
      <div class="nav"><button class="backbtn" data-back="1">← Назад</button><span>${esc(label || "")}</span></div>
      ${title ? `<h2>${esc(title)}</h2>` : ""}${lead ? `<p class="lead">${esc(lead)}</p>` : ""}
    </div></header>`;
  const managerLink = (text) => { const u = safeUrl(C.manager); return u ? `<a class="linkbtn" href="${esc(u)}" target="_blank" rel="noopener" data-ext="1">${esc(text)}</a>` : ""; };

  /* ---------- 1 · услуги ---------- */
  function catalog() {
    const list = services();
    const d = discount();
    const card = (s, i) => `
      <button class="svc ${s.featured ? "hot" : ""}" style="--i:${i}" data-open="${esc(s.id)}">
        ${cart.has(s.id) ? '<span class="in-cart">в заявке</span>' : ""}
        <span class="ic t-${PASTEL[i % PASTEL.length]}">${icon(s.icon)}</span>
        <span class="svc-tx">
          <span class="svc-top"><b>${esc(s.title)}</b>${s.badge ? `<em class="badge">${esc(s.badge)}</em>` : ""}</span>
          ${s.short ? `<span class="svc-sh">${esc(s.short)}</span>` : ""}
          <span class="svc-pr"><b>от ${money(now(s))}</b>${d ? `<s>${num(s.price)}</s>` : ""}${s.term ? `<small>${esc(s.term)}</small>` : ""}</span>
        </span>
      </button>`;
    return `
      <header class="head"><div class="in">
        <div class="brandline"><span class="brand">${logo(true)}<span>${esc(C.brand)}</span></span></div>
        <h1>Услуги для бизнеса <span class="hl">с&nbsp;ценами сразу</span></h1>
        <p class="lead">Сайты, каталоги, боты и реклама. Без «позвоните — узнаете». Нажмите на услугу, чтобы увидеть, что входит.</p>
        <button class="btn peach sm" data-go="chat"><svg aria-hidden="true"><use href="#i-chat"/></svg>Спросить ИИ-помощника</button>
      </div></header>
      <div class="body">
        <div class="list">${list.map(card).join("") || '<div class="empty">Скоро здесь появятся услуги.</div>'}</div>
        ${C.guarantee ? `<p class="guar">${esc(C.guarantee)}</p>` : ""}
        ${managerLink("Написать менеджеру")}
      </div>
      <div class="bar ${inTg ? "tg-hidden" : ""}"><button class="btn" data-go="order">${cart.size ? "Оставить заявку · " + cart.size : "Оставить заявку"}</button></div>`;
  }

  /* ---------- 2 · пакеты ---------- */
  function pkgs() {
    const list = packages();
    if (!pickedPkg || !list.find((p) => p.id === pickedPkg)) pickedPkg = (list.find((p) => p.featured) || list[0] || {}).id;
    const d = discount();
    const row = (p, i) => `
      <button class="pk ${p.id === pickedPkg ? "on" : ""}" style="--i:${i}" data-pkg="${esc(p.id)}" aria-pressed="${p.id === pickedPkg}">
        <span class="tick">${'<svg aria-hidden="true"><use href="#i-check"/></svg>'}</span>
        <h3>${esc(p.title)}${p.badge ? `<em class="badge">${esc(p.badge)}</em>` : ""}</h3>
        <span class="pr">${d ? `<s>${num(p.price)}</s>` : ""}<b>${money(now(p))}</b><small>${esc(unit(p.term))}</small></span>
        ${p.short ? `<p>${esc(p.short)}</p>` : ""}
      </button>`;
    const pick = byId(pickedPkg);
    return `
      <header class="head sm"><div class="in">
        <div class="brandline"><span class="brand">${logo(true)}<span>${esc(C.brand)}</span></span></div>
        <h2>Пакеты</h2>
        <p class="lead">Готовые наборы услуг. Выберите подходящий и оставьте заявку.</p>
        ${d ? `<p style="margin-top:12px"><span class="pill">Скидка первому клиенту в нише −${d}%</span></p>` : ""}
      </div></header>
      <div class="body">
        <div class="list" style="margin-top:20px">${list.map(row).join("") || '<div class="empty">Пакеты пока не добавлены.</div>'}</div>
        ${pick ? `<button class="linkbtn" data-open="${esc(pick.id)}">Что входит в «${esc(pick.title)}»</button>` : ""}
        <p class="note">Рекламный бюджет оплачивается отдельно, напрямую в Instagram.</p>
        ${C.guarantee ? `<p class="guar">${esc(C.guarantee)}</p>` : ""}
      </div>
      ${pick ? `<div class="bar ${inTg ? "tg-hidden" : ""}"><button class="btn" data-order="${esc(pick.id)}">Беру «${esc(pick.title)}»</button></div>` : ""}`;
  }

  /* ---------- 3 · карточка услуги ---------- */
  function detail(id) {
    const s = byId(id);
    if (!s) return catalog();
    const d = discount();
    const inCart = cart.has(id);
    const isPkg = s.kind === "package";
    const all = services();
    const n = all.indexOf(s);
    return `
      ${subhead(isPkg ? "пакет" : n >= 0 ? "услуга " + (n + 1) + " из " + all.length : "услуга", s.title, s.short)}
      <div class="body">
        <div class="card">
          <div class="price"><b>${isPkg ? "" : "от "}${money(now(s))}</b>${d ? `<s>${num(s.price)}</s><span class="badge">−${d}% первому в нише</span>` : ""}</div>
          ${s.term ? `<div class="term">${esc(s.term)}</div>` : ""}
          ${s.description ? `<p class="desc">${esc(s.description)}</p>` : ""}
        </div>
        ${C.guarantee ? `<p class="guar">${esc(C.guarantee)}</p>` : ""}
        ${s.includes && s.includes.length ? `<h3 class="sec">Что входит</h3><ul class="inc">${s.includes.map((x) => `<li><span><svg aria-hidden="true"><use href="#i-check"/></svg></span>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${s.steps && s.steps.length ? `<h3 class="sec">Как работаем</h3><ol class="steps">${s.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}
        <div class="row2">
          <button class="btn o" data-ask="${esc(s.id)}"><svg aria-hidden="true"><use href="#i-chat"/></svg>Спросить в чате</button>
          <button class="btn o" data-add="${esc(s.id)}">${inCart ? "Убрать из заявки" : "Добавить в заявку"}</button>
        </div>
      </div>
      <div class="bar ${inTg ? "tg-hidden" : ""}"><button class="btn" data-order="${esc(s.id)}">Оставить заявку</button></div>`;
  }

  /* ---------- 4 · заявка ---------- */
  function order() {
    const items = selected();
    const u = (inTg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
    if (!quiz.name && u) quiz.name = [u.first_name, u.last_name].filter(Boolean).join(" ");
    const other = quiz.niche && !NICHES.slice(0, -1).includes(quiz.niche);
    return `
      ${subhead("заявка", "Оставьте заявку", "Менеджер свяжется с вами, уточнит задачу и назовёт итоговую цену.")}
      <div class="body">
        <div class="card">
          <div class="chosen">
            <span class="lbl">${items.length ? "Вы выбрали" : "Пока ничего не выбрано"}</span>
            ${items.map((s) => `<span class="tag">${esc(s.title)}<button data-add="${esc(s.id)}" aria-label="Убрать «${esc(s.title)}»">✕</button></span>`).join("")}
            <button class="add" data-go="catalog">${items.length ? "+ добавить" : "Выбрать услугу"}</button>
          </div>
          <div class="f" id="nameBox"><label for="nameInput">Имя</label><input id="nameInput" value="${esc(quiz.name)}" placeholder="Как к вам обращаться" autocomplete="name"></div>
          <div class="f" id="phoneBox"><label for="phoneInput">Телефон</label><input id="phoneInput" type="tel" inputmode="tel" value="${esc(quiz.phone)}" placeholder="+996 ___ __ __ __" autocomplete="tel"></div>
          ${inTg && tg.requestContact ? `<button type="button" class="tgl ${quiz.tgPhone && quiz.phone ? "done" : ""}" id="shareBtn">${quiz.tgPhone && quiz.phone ? "Номер взяли из Telegram" : "Взять номер из Telegram"}</button>` : ""}
          <div class="f"><label for="taskInput">Задача</label><input id="taskInput" value="${esc(quiz.task)}" placeholder="По желанию"></div>
          <input id="websiteInput" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
          <div class="f" style="margin-top:18px"><span class="flabel">Ваша ниша</span></div>
          <div class="chips">${NICHES.map((n) => `<button class="chip ${quiz.niche === n || (n === "Другое" && other) ? "on" : ""}" data-pick="niche" data-value="${esc(n)}" aria-pressed="${quiz.niche === n || (n === "Другое" && other)}">${esc(n)}</button>`).join("")}</div>
          ${other ? `<div class="f"><label for="nicheInput">Чем занимаетесь</label><input id="nicheInput" value="${esc(quiz.niche === "Другое" ? "" : quiz.niche)}" placeholder="Например, автосервис"></div>` : ""}
          <div class="msg" id="formMsg" role="alert"></div>
        </div>
        <p class="note">Имя и телефон видит только наш менеджер. Используем их, чтобы связаться по заявке, без рассылок.</p>
      </div>
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
    if (!cart.size) return (msg.textContent = "Выберите услугу или пакет.");
    if (!quiz.name) return bad("nameBox", "Напишите имя");
    if (!/^\+?[\d\s()-]{9,18}$/.test(quiz.phone)) return bad("phoneBox", "Напишите телефон");
    if (!quiz.niche) return (msg.textContent = "Выберите вашу нишу");
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
      haptic("notificationOccurred", "success");
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
      if (ok && c && c.phone_number) { quiz.phone = (c.phone_number.startsWith("+") ? "" : "+") + c.phone_number; quiz.tgPhone = true; render(); }
    };
    try { tg.requestContact(done); } catch (e) { console.warn(e); }
  }

  /* ---------- 5 · заявка принята ---------- */
  function success() {
    const o = lastOrder || { id: "—", name: "", phone: "", niche: "", services: [] };
    return `
      <header class="head"><div class="in">
        <div class="brandline"><span class="brand">${logo(true)}<span>${esc(C.brand)}</span></span></div>
        <div class="done-ic"><svg aria-hidden="true"><use href="#i-check"/></svg></div>
        <h2>Заявка № ${esc(o.id)} принята</h2>
        <p class="lead">${inTg ? "Менеджер напишет вам в Telegram или позвонит в рабочее время." : "Менеджер позвонит вам по указанному номеру в рабочее время."}</p>
      </div></header>
      <div class="body">
        <div class="card rows">
          <div class="tr"><span>Услуги</span><div>${o.services.map(esc).join(", ")}</div></div>
          ${o.niche ? `<div class="tr"><span>Ниша</span><div>${esc(o.niche)}</div></div>` : ""}
          <div class="tr"><span>Имя</span><div>${esc(o.name)}</div></div>
          <div class="tr"><span>Телефон</span><div>${esc(o.phone)}</div></div>
        </div>
        <p class="note">Пока ждёте, можно задать вопрос ИИ-помощнику во вкладке «Чат».</p>
        <button class="linkbtn" data-go="catalog">Вернуться к услугам</button>
      </div>
      ${safeUrl(C.manager) ? `<div class="bar ${inTg ? "tg-hidden" : ""}"><a class="btn o" href="${esc(safeUrl(C.manager))}" target="_blank" rel="noopener" data-ext="1">Написать менеджеру</a></div>` : ""}`;
  }

  /* ---------- 6 · чат с ИИ-помощником ---------- */
  function chatScreen() {
    const head = `
      <header class="head sm"><div class="in"><div class="who">
        <span class="ava">${logo(false)}</span>
        <span><b>Помощник ${esc(C.brand)}</b><small>ИИ отвечает на вопросы об услугах и ценах</small></span>
      </div></div></header>`;
    if (!inTg) {
      return head + `
        <div class="body"><div class="card tgonly">
          <span class="ic t-lavender"><svg aria-hidden="true"><use href="#i-chat"/></svg></span>
          <h3>Чат с помощником работает в Telegram</h3>
          <p>Напишите нашему боту: он ответит на вопросы и поможет выбрать услугу.</p>
          <a class="btn wide" href="${BOT_URL}" target="_blank" rel="noopener" data-ext="1">Написать в Telegram</a>
        </div></div>`;
    }
    return head + `
      <div class="body"><div class="chat-list" id="chatList" role="log" aria-live="polite" aria-label="Переписка с помощником"></div></div>
      <form class="composer" id="chatForm" novalidate>
        <div class="composer-in">
          <label class="visually-hidden" for="chatInput">Сообщение</label>
          <textarea id="chatInput" rows="1" maxlength="${CHAT_MAX}" placeholder="Напишите сообщение" enterkeyhint="send"></textarea>
          <button class="send" id="chatSend" type="submit" aria-label="Отправить"><svg aria-hidden="true"><use href="#i-send"/></svg></button>
        </div>
        <div class="chars" id="chatChars" hidden></div>
      </form>`;
  }
  // текст с кликабельными https-ссылками: только textContent и созданные <a>, без innerHTML
  function appendLinked(node, text) {
    const re = /https:\/\/[^\s<>"'«»]+/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      let url = m[0];
      const trail = url.match(/[.,!?;:)\]}]+$/); // точка или скобка после ссылки — это уже текст
      if (trail) url = url.slice(0, -trail[0].length);
      node.append(document.createTextNode(text.slice(last, m.index)));
      let ok = false;
      try { ok = new URL(url).protocol === "https:"; } catch {}
      if (ok) {
        const a = document.createElement("a");
        a.href = url; a.textContent = url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.dataset.ext = "1";
        node.append(a);
      } else node.append(document.createTextNode(url));
      last = m.index + url.length;
      re.lastIndex = last;
    }
    node.append(document.createTextNode(text.slice(last)));
  }
  function bubble(role, text) {
    const b = document.createElement("div");
    b.className = "bub " + (role === "user" ? "me" : "bot");
    appendLinked(b, String(text || ""));
    return b;
  }
  function drawChat() {
    const list = document.getElementById("chatList");
    if (!list) return;
    list.textContent = "";
    const add = (cls, text) => { const e = document.createElement("div"); e.className = cls; e.textContent = text; list.append(e); };
    if (chat.loading && !chat.msgs.length) add("chat-note", "Загружаю переписку…");
    if (chat.greet) list.append(bubble("assistant", GREETING));
    chat.msgs.forEach((m) => list.append(bubble(m.role, m.text)));
    if (chat.sending) {
      const t = document.createElement("div");
      t.className = "typing";
      t.innerHTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>'; // статичная разметка, без данных
      t.append(document.createTextNode("печатает…"));
      list.append(t);
    }
    if (chat.error) add("chat-err", chat.error);
    updateSend();
    scrollChat();
  }
  function scrollChat() { if (view.name === "chat") window.scrollTo(0, document.documentElement.scrollHeight); }
  function updateSend() {
    const inp = document.getElementById("chatInput"), btn = document.getElementById("chatSend"), cnt = document.getElementById("chatChars");
    if (!inp || !btn) return;
    btn.disabled = chat.sending || !inp.value.trim();
    const len = inp.value.length;
    if (cnt) { cnt.hidden = len < CHAT_MAX - 100; cnt.textContent = len + " / " + CHAT_MAX; }
  }
  function autosize(el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight + 4, 140) + "px"; }
  async function chatFetch(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT);
    try {
      const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
      return await r.json().catch(() => ({})); // ответ читаем и при 4xx/5xx: там тоже может быть reply
    } finally { clearTimeout(timer); }
  }
  async function loadHistory() {
    if (!inTg || !API || chat.loading || chat.sending) return;
    chat.loading = true; drawChat();
    try {
      const res = await chatFetch("/api/chat/history", { initData: initData() });
      if (res && res.ok && Array.isArray(res.messages) && !chat.sending) {
        const list = res.messages
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
          .slice(-60).map((m) => ({ role: m.role, text: m.text }));
        if (list.length >= chat.msgs.length) chat.msgs = list;
        chat.greet = !list.length; // приветствие — только если истории нет
      }
    } catch (e) { console.warn("История чата:", e.message); }
    chat.loading = false;
    drawChat();
  }
  async function sendChat() {
    const inp = document.getElementById("chatInput");
    const text = (inp ? inp.value : chat.draft).trim().slice(0, CHAT_MAX);
    if (!text || chat.sending) return; // блокировка двойной отправки
    chat.sending = true; chat.error = ""; chat.draft = "";
    chat.msgs.push({ role: "user", text });
    if (inp) { inp.value = ""; autosize(inp); }
    drawChat();
    let reply = "", err = "";
    try {
      const res = (await chatFetch("/api/chat", { message: text, source: "miniapp", initData: initData() })) || {};
      if (typeof res.reply === "string" && res.reply.trim()) reply = res.reply; // ok:true или ok:false с запасным текстом
      else err = CHAT_ERR[res.error] || CHAT_ERR.default;
      if (res.ok && res.lead) haptic("notificationOccurred", "success");
    } catch { err = CHAT_ERR.default; }
    chat.sending = false;
    if (reply) chat.msgs.push({ role: "assistant", text: reply });
    else {
      // не ушло: убираем сообщение и возвращаем текст в поле, чтобы отправить ещё раз
      chat.msgs.pop();
      chat.error = err;
      const cur = document.getElementById("chatInput");
      if (cur && !cur.value.trim()) { cur.value = text; autosize(cur); }
      else if (!cur && !chat.draft) chat.draft = text;
    }
    drawChat();
  }
  function setupChat() {
    const inp = document.getElementById("chatInput");
    if (!inp) return;
    inp.value = chat.draft;
    autosize(inp);
    drawChat();
    loadHistory(); // историю подтягиваем при каждом открытии вкладки (общая с перепиской в боте)
  }
  function askAbout(id) {
    const s = byId(id);
    if (!s) return;
    chat.draft = `Расскажите подробнее про «${s.title}»: что входит и сколько это будет стоить для моего бизнеса?`;
    chat.error = "";
    go("chat");
    const inp = document.getElementById("chatInput");
    if (inp) { inp.focus({ preventScroll: true }); inp.setSelectionRange(inp.value.length, inp.value.length); updateSend(); }
  }
  // клавиатура телефона: на iOS окно не сжимается, поэтому поднимаем поле ввода на высоту клавиатуры
  function onViewport() {
    const vv = window.visualViewport;
    const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
    document.documentElement.style.setProperty("--kb", (document.body.classList.contains("kb-open") ? kb : 0) + "px");
    if (document.body.classList.contains("kb-open")) scrollChat();
  }
  if (window.visualViewport) { visualViewport.addEventListener("resize", onViewport); visualViewport.addEventListener("scroll", onViewport); }

  /* ---------- админ-панель ---------- */
  function admin() {
    const list = adminData.services;
    return `${subhead("админ", "Услуги и пакеты · " + list.length)}
      <div class="body">
        <p class="note">В поле «Цена от» пишите обычную цену. Если в настройках стоит скидка первому клиенту, приложение само зачеркнёт эту цену и покажет цену со скидкой.</p>
        <div class="arow">
          <button class="abtn" data-go="adminOrders">Заявки</button>
          <button class="abtn" data-go="adminSettings">Настройки</button>
          <button class="abtn g" data-edit="new">+ Услуга</button>
        </div>
        <div class="msg" id="adminMsg"></div>
        ${list.length ? "" : '<div class="empty">Загружаю…</div>'}
        ${list.length ? `<div class="alist">${list.map((s, i) => `
          <div class="arow-item ${s.active ? "" : "off"}">
            <div class="ic t-${PASTEL[i % PASTEL.length]}">${icon(s.icon)}</div>
            <div class="grow"><div class="n">${esc(s.title)} ${s.kind === "package" ? '<span class="tgtag">пакет</span>' : ""} ${s.active ? "" : '<span class="tgtag">скрыта</span>'}</div><div class="p">от ${money(s.price)} · ${esc(s.term)}</div></div>
            <button class="abtn sm" data-edit="${esc(s.id)}">Изменить</button>
          </div>`).join("")}</div>` : ""}
      </div>`;
  }

  function adminEdit(id) {
    const s = id === "new" ? { id: "", title: "", short: "", description: "", price: "", term: "", badge: "", icon: "catalog", featured: false, includes: [], steps: [], sort: 100, active: true, kind: "service", category: "" } : adminData.services.find((x) => x.id === id);
    if (!s) return admin();
    const f = (label, name, value, ph, type) => `<div class="field"><label>${label}</label><div class="inp">${type === "ta" ? `<textarea name="${name}" placeholder="${esc(ph || "")}">${esc(value)}</textarea>` : `<input name="${name}" placeholder="${esc(ph || "")}" value="${esc(value)}">`}</div></div>`;
    return `${subhead(id === "new" ? "новая услуга" : "редактирование", s.title || "Услуга")}
      <div class="body">
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
        <label class="check"><input type="checkbox" name="featured" ${s.featured ? "checked" : ""}> Выделять карточку рамкой</label>
        <label class="check"><input type="checkbox" name="active" ${s.active ? "checked" : ""}> Показывать клиентам</label>
        <div class="msg" id="adminMsg"></div>
        ${id !== "new" ? `<button type="button" class="abtn danger" data-del="${esc(s.id)}">Удалить</button>` : ""}
        <div class="bar"><button class="btn o" type="button" data-go="admin">Отмена</button><button class="btn" type="submit" id="saveBtn">Сохранить</button></div>
      </form>
      </div>`;
  }

  function adminOrders() {
    const list = adminData.orders;
    return `${subhead("админ", "Заявки · " + list.length)}
      <div class="body">
      <div class="msg" id="adminMsg"></div>
      ${list.length ? "" : '<div class="empty">Заявок пока нет.</div>'}
      ${list.map((o) => `
        <div class="ticket">
          <div class="tr"><span>№${esc(o.id)}</span><div>${esc(new Date(o.created_at).toLocaleString("ru-RU"))}</div></div>
          <div class="tr"><span>Клиент</span><div style="text-align:right">${esc(o.name)} ${o.username ? esc(o.username) : ""}<br><a href="tel:${esc(String(o.phone || "").replace(/[^\d+]/g, ""))}">${esc(o.phone)}</a></div></div>
          <div class="tr"><span>Услуги</span><div style="text-align:right">${(o.services || []).map(esc).join(", ")}</div></div>
          ${o.niche ? `<div class="tr"><span>Ниша</span><div>${esc(o.niche)}</div></div>` : ""}
          ${o.budget ? `<div class="tr"><span>Бюджет</span><div>${esc(o.budget)}</div></div>` : ""}
          ${o.comment ? `<div class="tr"><span>Задача</span><div style="text-align:right">${esc(o.comment)}</div></div>` : ""}
          <div class="tr"><span>Статус</span><select class="status" data-order-id="${esc(o.id)}">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${o.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        </div>`).join("")}
      </div>
      <div class="bar"><button class="btn o" data-go="admin">Назад</button></div>`;
  }

  function adminSettings() {
    return `${subhead("админ", "Настройки")}
      <div class="body">
      <form id="settingsForm" novalidate>
        <div class="field"><label>Название бренда</label><div class="inp"><input name="brand" value="${esc(C.brand)}"></div></div>
        <div class="field"><label>Валюта</label><div class="inp"><input name="currency" value="${esc(C.currency)}" placeholder="сом"></div></div>
        <div class="field"><label>Ссылка «Написать менеджеру» (https://…)</label><div class="inp"><input name="manager" value="${esc(C.manager)}" placeholder="https://t.me/username"></div></div>
        <div class="field"><label>Скидка первому клиенту, % (0 = не показывать)</label><div class="inp"><input name="pilot_discount" inputmode="numeric" value="${esc(C.pilot_discount || 0)}"></div></div>
        <div class="field"><label>Текст гарантии в карточке (пусто = не показывать)</label><div class="inp"><textarea name="guarantee">${esc(C.guarantee || "")}</textarea></div></div>
        <div class="msg" id="adminMsg"></div>
        <div class="bar"><button class="btn o" type="button" data-go="admin">Отмена</button><button class="btn" type="submit">Сохранить</button></div>
      </form>
      </div>`;
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
    if (el) { el.textContent = text; el.classList.toggle("ok", !!ok); }
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
    tg.MainButton.setParams({ text: p.text, color: COLORS.violet, text_color: "#ffffff", is_visible: true, is_active: !p.progress });
    p.progress ? tg.MainButton.showProgress() : tg.MainButton.hideProgress();
  }
  function updateMain() {
    const n = cart.size;
    if (view.name === "catalog") return setMain({ text: n ? "Оставить заявку · " + n : "Оставить заявку" });
    if (view.name === "packages") { const p = byId(pickedPkg); return setMain(p ? { text: "Беру «" + p.title + "»" } : null); }
    if (view.name === "detail") { const s = byId(view.arg); return setMain(s ? { text: "Оставить заявку" } : null); }
    if (view.name === "order") return setMain({ text: "Отправить заявку" });
    if (view.name === "success") return setMain(safeUrl(C.manager) ? { text: "Написать менеджеру" } : null);
    setMain(null); // в чате и админке родная кнопка не нужна
  }
  function openExternal(url) {
    if (!safeUrl(url)) return;
    if (inTg && /^https:\/\/t\.me\//i.test(url) && tg.openTelegramLink) return tg.openTelegramLink(url);
    if (inTg && tg.openLink) return tg.openLink(url);
    window.open(url, "_blank", "noopener");
  }
  function mainAction() {
    if (view.name === "catalog") return go("order");
    if (view.name === "packages") { if (pickedPkg) { cart.add(pickedPkg); saveCart(); } return go("order"); }
    if (view.name === "detail") { cart.add(view.arg); saveCart(); return go("order"); }
    if (view.name === "order") return next();
    if (view.name === "success") return openExternal(safeUrl(C.manager));
  }

  /* ---------- рендер ---------- */
  const screens = { catalog, packages: pkgs, order, success, chat: chatScreen, admin, adminOrders, adminSettings };
  function render() {
    // черновик чата не теряем при переходе на другую вкладку
    const ci = document.getElementById("chatInput");
    if (ci) chat.draft = ci.value;
    document.body.classList.remove("kb-open");
    document.documentElement.style.setProperty("--kb", "0px");
    app.innerHTML = screens[view.name] ? screens[view.name]() : view.name === "adminEdit" ? adminEdit(view.arg) : detail(view.arg);
    const nested = !["catalog", "packages", "success", "chat"].includes(view.name);
    document.body.classList.toggle("has-bar", !!app.querySelector(".bar:not(.tg-hidden)"));
    document.body.classList.toggle("chat-on", view.name === "chat" && inTg);
    tabs.querySelectorAll(".tab").forEach((t) => {
      const on = t.dataset.go === view.name || (view.name === "detail" && t.dataset.go === "catalog") || (view.name === "success" && t.dataset.go === "order") || (view.name.startsWith("admin") && t.dataset.go === "admin");
      t.classList.toggle("on", on);
      if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
    if (tg) nested ? tg.BackButton.show() : tg.BackButton.hide();
    updateMain();
    if (view.name === "chat") setupChat();
  }

  document.addEventListener("click", (e) => {
    const ext = e.target.closest("a[data-ext]");
    if (ext) { if (inTg) { e.preventDefault(); openExternal(ext.href); } return; }
    const t = e.target.closest("[data-add],[data-open],[data-go],[data-order],[data-edit],[data-del],[data-back],[data-pkg],[data-pick],[data-next],[data-ask],#shareBtn");
    if (!t) return;
    if (t.dataset.add) { e.preventDefault(); e.stopPropagation(); return toggle(t.dataset.add); }
    if (t.dataset.back) return back();
    if (t.dataset.ask) return askAbout(t.dataset.ask);
    if (t.dataset.pkg) {
      pickedPkg = t.dataset.pkg;
      haptic("selectionChanged");
      app.querySelectorAll(".pk").forEach((x) => { x.classList.toggle("on", x === t); x.setAttribute("aria-pressed", String(x === t)); });
      const b = app.querySelector(".bar .btn"); const p = byId(pickedPkg);
      if (b && p) { b.dataset.order = p.id; b.textContent = "Беру «" + p.title + "»"; }
      const l = app.querySelector(".linkbtn[data-open]"); if (l && p) { l.dataset.open = p.id; l.textContent = "Что входит в «" + p.title + "»"; }
      return updateMain();
    }
    if (t.dataset.pick) { readStep(); quiz[t.dataset.pick] = t.dataset.value; haptic("impactOccurred", "medium"); return render(); }
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
  // кнопка «Отправить» не забирает фокус у поля: клавиатура не прячется и таб-бар не прыгает под пальцем
  document.addEventListener("pointerdown", (e) => { if (e.target.closest("#chatSend")) e.preventDefault(); });
  document.addEventListener("submit", (e) => {
    e.preventDefault();
    const formId = e.target.getAttribute("id"); // не e.target.id: поле name="id" внутри формы перекрывает свойство
    if (formId === "chatForm") return sendChat();
    if (formId === "serviceForm") saveService(e.target);
    if (formId === "settingsForm") {
      post("/api/admin/settings", { settings: Object.fromEntries(new FormData(e.target).entries()) })
        .then((r) => { C = { ...C, ...r.settings }; showMsg("Сохранено", true); })
        .catch((er) => showMsg(er.message));
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.classList.contains("status")) {
      post("/api/admin/orders/status", { id: e.target.dataset.orderId, status: e.target.value }).then(() => showMsg("Статус обновлён", true)).catch((er) => showMsg(er.message));
    }
    if (e.target.name === "icon") document.querySelectorAll(".ico").forEach((l) => l.classList.toggle("on", l.querySelector("input").checked));
  });
  document.addEventListener("input", (e) => {
    const f = e.target.closest(".f.err"); if (f) f.classList.remove("err");
    if (e.target.id === "chatInput") { chat.draft = e.target.value; autosize(e.target); updateSend(); }
  });
  document.addEventListener("focusin", (e) => { if (e.target.id === "chatInput") { document.body.classList.add("kb-open"); setTimeout(onViewport, 300); } });
  document.addEventListener("focusout", (e) => { if (e.target.id === "chatInput") { document.body.classList.remove("kb-open"); document.documentElement.style.setProperty("--kb", "0px"); } });
  document.addEventListener("keydown", (e) => {
    // Enter отправляет с клавиатуры компьютера; на телефоне Enter — новая строка, отправка кнопкой
    if (e.target.id === "chatInput" && e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(pointer:fine)").matches) { e.preventDefault(); return sendChat(); }
    if (e.key === "Escape" && !["catalog", "chat"].includes(view.name)) back();
  });

  /* для скриншотов: ?screen=packages|detail:ads|order|success|chat */
  if (new URLSearchParams(location.search).has("still")) document.documentElement.classList.add("still");
  const q = new URLSearchParams(location.search).get("screen");
  if (q) { const [n, a] = q.split(":"); if (n === "success") lastOrder = { id: 1007, name: "Адука", phone: "+996 555 12 34 56", niche: "Стоматология", services: ["Поток клиентов"] }; if (n === "order") { cart.add("flow"); quiz.name = "Адука"; quiz.niche = "Стоматология"; } view = { name: n, arg: a }; }

  saveCart();
  render();
  loadCatalog();
})();

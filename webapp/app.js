/* Caravel Mini App: каталог услуг, карточка, заявка. */
(function () {
  const C = window.CARAVEL;
  const tg = window.Telegram && window.Telegram.WebApp;
  const API = (window.CARAVEL_API || "").replace(/\/$/, ""); // адрес бота, задаётся в config.js
  const app = document.getElementById("app");
  const tabs = document.getElementById("tabs");
  const cart = new Set(JSON.parse(sessionStorage.getItem("cart") || "[]"));
  let view = { name: "catalog" };
  let lastOrder = null;

  if (tg) {
    tg.ready();
    tg.expand();
    tg.setHeaderColor("#0b0b0c");
    tg.setBackgroundColor("#0b0b0c");
    tg.BackButton.onClick(() => go("catalog"));
  }
  document.getElementById("managerTab").href = C.manager;

  const money = (n) => n.toLocaleString("ru-RU") + " " + C.currency;
  const byId = (id) => C.services.find((s) => s.id === id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const icon = (name, cls) => `<svg class="${cls || ""}"><use href="#i-${name}"/></svg>`;

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
  function go(name, arg) {
    view = { name, arg };
    window.scrollTo(0, 0);
    render();
  }

  /* ---------- экраны ---------- */
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
      <div class="brand serif"><span class="logo">C</span>${esc(C.brand)}</div>
      <div class="eyebrow">${C.services.length} услуг под ключ</div>
      <h1 class="serif">Digital-решения <em>для бизнеса</em></h1>
      <p class="sub">Выберите услуги, узнайте детали и оставьте заявку в пару касаний.</p>
      ${featured.map((s) => card(s, true)).join("")}
      <div class="grid">${rest.map((s) => card(s, false)).join("")}</div>`;
  }

  function detail(id) {
    const s = byId(id);
    const inCart = cart.has(id);
    return `
      <div class="hero">${s.badge ? `<span class="badge">${esc(s.badge)}</span>` : ""}${icon(s.icon)}</div>
      <div class="eyebrow">Услуга</div>
      <h2 class="serif">${esc(s.title)}</h2>
      <div class="chips">
        <div class="chip g">Стоимость<b>от ${money(s.price)}</b></div>
        <div class="chip">Срок<b>${esc(s.term)}</b></div>
        <div class="chip">Формат<b>под ключ</b></div>
      </div>
      <p class="sub" style="margin-top:14px">${esc(s.desc)}</p>
      <div class="sec">Что входит</div>
      ${s.includes.map((x) => `<div class="li"><i>✓</i>${esc(x)}</div>`).join("")}
      <div class="sec">Как работаем</div>
      <div class="steps">${s.steps.map((x, i) => `<div class="st"><b class="serif">0${i + 1}</b>${esc(x)}</div>`).join("")}</div>
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
        <div class="field"><label>Телефон</label><div class="inp" id="phoneBox"><input name="phone" type="tel" inputmode="tel" placeholder="+7 700 000 00 00" autocomplete="tel"></div></div>
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
        <div class="eyebrow" style="margin-top:28px">Заявка №${o.id}</div>
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

  /* ---------- отправка ---------- */
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
    const payload = { name, phone, comment, services: [...cart], initData: tg ? tg.initData : "" };
    btn.disabled = true;
    btn.textContent = "Отправляем…";
    try {
      let res;
      if (API) {
        const r = await fetch(API + "/api/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        res = await r.json();
        if (!r.ok || !res.ok) throw new Error(res.error || "Ошибка сервера");
      } else if (tg && tg.sendData) {
        // Режим без сервера: данные уходят боту через sendData (работает при открытии с reply-кнопки).
        tg.sendData(JSON.stringify(payload));
        res = { id: "—" };
      } else {
        res = { id: "DEMO" }; // локальный просмотр без Telegram
      }
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

  /* ---------- рендер ---------- */
  function render() {
    const html = { catalog, order, success }[view.name] ? { catalog, order, success }[view.name]() : detail(view.arg);
    app.innerHTML = html;
    const hasBar = view.name !== "catalog";
    document.body.classList.toggle("has-bar", hasBar);
    tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.go === view.name));
    if (tg) view.name === "catalog" ? tg.BackButton.hide() : tg.BackButton.show();
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-add],[data-open],[data-go],[data-order]");
    if (!t) return;
    if (t.dataset.add) { e.preventDefault(); e.stopPropagation(); return toggle(t.dataset.add); }
    if (t.dataset.open) return go("detail", t.dataset.open);
    if (t.dataset.go) return go(t.dataset.go);
    if (t.dataset.order) { cart.add(t.dataset.order); saveCart(); return go("order"); }
  });
  document.addEventListener("submit", (e) => {
    if (e.target.id === "orderForm") { e.preventDefault(); submit(e.target); }
  });

  saveCart();
  render();
})();

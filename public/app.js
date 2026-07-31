(() => {
  "use strict";

  const DEFAULT_PEOPLE = [
    "Simon", "Erwin", "Reni", "Regine", "Alex Wien", "Alex Deutschland",
    "Samy", "Iyad", "Adriana", "Tolga", "Miran",
  ];

  const STORAGE_KEY = "sammelbestellung-state-v1"; // Fallback nur falls Server nicht erreichbar
  const API_URL = "/api/state";
  const POLL_INTERVAL_MS = 3000;

  const ICONS = {
    plus: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
    plusSmall: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
    x: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    xTiny: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    pencil: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    pencilTiny: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    trash: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>',
    check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    bag: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/></svg>',
    users: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-3px"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  };

  function uid() {
    return "id-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function currency(n) {
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function makeOrder(title) {
    return { id: uid(), title, products: [], shipping: "", discount: "", priceList: [], priceListName: "" };
  }

  function defaultState() {
    const order = makeOrder("Sammelbestellung 1");
    return { people: DEFAULT_PEOPLE.slice(), orders: [order], activeId: order.id };
  }

  function loadLocalFallback() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.orders) && parsed.orders.length > 0) {
          return parsed;
        }
      }
    } catch (e) {
      /* ignore corrupt storage */
    }
    return defaultState();
  }

  // ---------- Preisliste (Excel-Import) ----------
  // Erwartetes Format: Spalten "Produkt", "Menge", "Preis"
  // (Groß-/Kleinschreibung und Reihenfolge egal). Wird komplett im Browser
  // mit SheetJS geparst - kein Server-Roundtrip nötig, das Ergebnis landet
  // einfach als normales Feld im Order-Objekt und wird wie alles andere
  // synchronisiert.
  const COLUMN_ALIASES = {
    name: ["produkt", "product", "artikel", "name"],
    qty: ["menge", "qty", "quantity", "anzahl"],
    price: ["preis", "price", "kosten", "cost"],
  };

  function normalizeHeader(h) {
    return String(h ?? "").trim().toLowerCase();
  }

  function findColumnKey(headerRow, aliases) {
    for (let i = 0; i < headerRow.length; i++) {
      const norm = normalizeHeader(headerRow[i]);
      if (aliases.includes(norm)) return i;
    }
    return -1;
  }

  function parsePriceListWorkbook(arrayBuffer) {
    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    const items = [];
    let sawAnySheet = false;

    workbook.SheetNames.forEach((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      if (rows.length === 0) return;
      sawAnySheet = true;

      const headerRow = rows[0];
      const nameIdx = findColumnKey(headerRow, COLUMN_ALIASES.name);
      const qtyIdx = findColumnKey(headerRow, COLUMN_ALIASES.qty);
      const priceIdx = findColumnKey(headerRow, COLUMN_ALIASES.price);

      // Produkt- und Preis-Spalte sind Pflicht; Menge optional.
      if (nameIdx === -1 || priceIdx === -1) return;

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row) continue;
        const name = String(row[nameIdx] ?? "").trim();
        if (!name) continue;
        const priceRaw = row[priceIdx];
        const priceNum = parseFloat(String(priceRaw ?? "").replace(",", "."));
        if (isNaN(priceNum)) continue;
        const qtyRaw = qtyIdx !== -1 ? row[qtyIdx] : "";
        const qtyNum = parseInt(String(qtyRaw ?? "").replace(/[^0-9-]/g, ""), 10);

        items.push({
          name,
          qty: !isNaN(qtyNum) && qtyNum > 0 ? qtyNum : null,
          price: Math.round(priceNum * 100) / 100,
        });
      }
    });

    if (!sawAnySheet) {
      throw new Error("Die Datei enthält keine lesbaren Tabellenblätter.");
    }
    if (items.length === 0) {
      throw new Error(
        'Keine gültigen Zeilen gefunden. Erwartet werden Spalten "Produkt", "Menge" und "Preis" (Menge optional).'
      );
    }
    return items;
  }

  function handlePriceListFile(order, file) {
    priceListError = "";
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const items = parsePriceListWorkbook(e.target.result);
        order.priceList = items;
        order.priceListName = file.name;
        priceListError = "";
      } catch (err) {
        priceListError = String(err.message || err);
      }
      render();
      persist();
    };
    reader.onerror = () => {
      priceListError = "Datei konnte nicht gelesen werden.";
      render();
    };
    reader.readAsArrayBuffer(file);
  }

  function matchPriceListItems(order, query) {
    const q = query.trim().toLowerCase();
    if (!q || !order.priceList || order.priceList.length === 0) return [];
    return order.priceList
      .filter((item) => item.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }

  const state = loadLocalFallback(); // wird direkt nach Serverantwort überschrieben
  // UI-only (not persisted meaningfully across reload need, but fine to keep)
  let formOpen = false;
  let editingProductId = null;
  let personPickerAdding = false;
  let peopleManagerOpen = false;
  let newPersonInputValue = "";
  let priceListError = "";
  let autocompleteOpen = false;
  let autocompleteActiveIndex = -1;

  // ---------- Server-Sync ----------
  // Der State lebt im Server (shared/state.json). Wir laden ihn beim Start,
  // pushen jede Änderung sofort per PUT, und pollen regelmäßig auf Änderungen
  // von anderen Geräten. localVersion verhindert, dass unser eigener Push
  // durch den nächsten Poll wieder überschrieben "zurückspringt".
  let serverVersion = 0;
  let syncing = false;
  let dirty = false;
  let lastPushed = null;
  let connectionOk = true;

  async function fetchState() {
    try {
      const res = await fetch(API_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("bad status");
      const data = await res.json();
      connectionOk = true;
      return data; // { version, state }
    } catch (e) {
      connectionOk = false;
      return null;
    }
  }

  async function pushState() {
    const payload = JSON.stringify(state);
    if (payload === lastPushed) return; // nichts geändert seit letztem Push
    try {
      const res = await fetch(API_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, baseVersion: serverVersion }),
      });
      if (res.ok) {
        const data = await res.json();
        serverVersion = data.version;
        lastPushed = payload;
        connectionOk = true;
      }
    } catch (e) {
      connectionOk = false;
      // Als Offline-Fallback lokal sichern, damit nichts verloren geht
      try { localStorage.setItem(STORAGE_KEY, payload); } catch (e2) {}
    }
  }

  function persist() {
    // Wird nach jedem render() aufgerufen. Statt sofort synchron zu speichern,
    // markieren wir "dirty" und pushen debounced, damit schnelle Tippfolgen
    // (z.B. beim Preis eingeben) nicht bei jedem Tastendruck einen Request feuern.
    dirty = true;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    schedulePush();
  }

  let pushTimer = null;
  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (dirty) {
        dirty = false;
        pushState();
      }
    }, 400);
  }

  function applyServerState(newState) {
    // Ersetzt den lokalen State komplett durch den vom Server, außer wir haben
    // gerade ungespeicherte Änderungen (dirty) oder ein offenes Formular -
    // dann überschreiben wir die UI nicht mitten in der Eingabe.
    Object.keys(state).forEach((k) => delete state[k]);
    Object.assign(state, newState);
  }

  async function initialLoad() {
    const data = await fetchState();
    if (data) {
      serverVersion = data.version;
      if (data.state && Array.isArray(data.state.orders) && data.state.orders.length > 0) {
        applyServerState(data.state);
      }
      // Ist der Server wirklich leer (erster Start) oder kurzzeitig nicht
      // erreichbar, wird NICHTS automatisch hochgeschrieben. Wir zeigen dann
      // einfach eine leere Sammelbestellung; der erste echte Push passiert
      // erst, wenn jemand aktiv etwas einträgt. So kann ein Verbindungsfehler
      // oder eine neu angelegte Datenbank niemals versehentlich bestehende
      // Daten überschreiben.
    } else {
      connectionOk = false;
    }
    render();
    startPolling();
  }

  function startPolling() {
    setInterval(async () => {
      if (formOpen || dirty || pushTimer) return; // während Eingabe/offenem Formular nicht überschreiben
      const data = await fetchState();
      if (data && data.version !== serverVersion) {
        serverVersion = data.version;
        applyServerState(data.state);
        render();
      }
    }, POLL_INTERVAL_MS);
  }

  function getActiveOrder() {
    return state.orders.find((o) => o.id === state.activeId) || state.orders[0];
  }

  function addPerson(name) {
    if (!state.people.includes(name)) state.people.push(name);
  }

  function removePerson(name) {
    // Person aus der globalen Liste entfernen...
    state.people = state.people.filter((p) => p !== name);
    // ...und aus allen Produkten in allen Sammelbestellungen austragen,
    // damit sie nirgends als "Geister-Teilnehmer" übrig bleibt.
    state.orders.forEach((order) => {
      order.products.forEach((product) => {
        product.participants = product.participants.filter((p) => p !== name);
      });
    });
  }

  // ---------- Bestätigungs-Dialog ----------
  // Generischer "Bist du sicher?"-Dialog für gefährliche Aktionen (z. B.
  // Löschen). Wird an document.body gehängt, damit er ein normales render()
  // übersteht, und ruft onConfirm() nur nach explizitem Bestätigen auf.
  function showConfirmDialog({ title, message, confirmLabel = "Löschen", onConfirm }) {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";

    const box = document.createElement("div");
    box.className = "confirm-box";
    box.innerHTML = `
      <div class="confirm-title">${esc(title)}</div>
      <div class="confirm-message">${esc(message)}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "confirm-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn secondary form-btn";
    cancelBtn.textContent = "Abbrechen";
    cancelBtn.addEventListener("click", () => overlay.remove());

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "btn danger-solid form-btn";
    confirmBtn.textContent = confirmLabel;
    confirmBtn.addEventListener("click", () => {
      overlay.remove();
      onConfirm();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    box.appendChild(actions);
    overlay.appendChild(box);

    // Klick auf den dunklen Hintergrund schließt den Dialog (wie Abbrechen)
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
  }

  // ---------- Rendering ----------

  const root = document.getElementById("app");

  function render() {
    const order = getActiveOrder();
    root.innerHTML = "";
    root.appendChild(renderHeader());
    root.appendChild(renderTabsBar());
    root.appendChild(renderOrderView(order));
    // WICHTIG: render() speichert absichtlich NICHT automatisch. Sonst würde
    // auch ein reines Polling-Update (frische Daten von einem anderen Gerät)
    // sofort wieder zurückgeschrieben. persist() wird stattdessen gezielt an
    // den Stellen aufgerufen, an denen der Nutzer selbst etwas geändert hat.
  }

  function renderHeader() {
    const header = document.createElement("header");
    header.className = "header";
    header.innerHTML = `
      <div class="header-icon">${ICONS.bag}</div>
      <div>
        <h1>Sammelbestellungen</h1>
        <p>Mehrere Bestellungen verwalten, Beteiligte wählen, Kosten aufteilen.</p>
      </div>
    `;
    return header;
  }

  function renderTabsBar() {
    const bar = document.createElement("div");
    bar.className = "tabs-bar";

    state.orders.forEach((o) => {
      bar.appendChild(renderTab(o));
    });

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "add-tab-btn";
    addBtn.setAttribute("aria-label", "Neue Sammelbestellung");
    addBtn.innerHTML = ICONS.plusSmall;
    addBtn.addEventListener("click", () => {
      const next = makeOrder(`Sammelbestellung ${state.orders.length + 1}`);
      state.orders.push(next);
      state.activeId = next.id;
      formOpen = false;
      editingProductId = null;
      render();
      persist();
    });
    bar.appendChild(addBtn);

    return bar;
  }

  function renderTab(order) {
    const wrap = document.createElement("div");
    const active = order.id === state.activeId;
    wrap.className = "tab" + (active ? " active" : "");
    wrap.dataset.editing = "false";

    function renderNormal() {
      wrap.innerHTML = "";
      wrap.className = "tab" + (active ? " active" : "");

      const labelBtn = document.createElement("button");
      labelBtn.type = "button";
      labelBtn.className = "tab-label";
      labelBtn.textContent = order.title;
      labelBtn.addEventListener("click", () => {
        state.activeId = order.id;
        formOpen = false;
        editingProductId = null;
        render();
        persist();
      });
      wrap.appendChild(labelBtn);

      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "tab-icon";
      renameBtn.setAttribute("aria-label", "Umbenennen");
      renameBtn.innerHTML = ICONS.pencilTiny;
      renameBtn.addEventListener("click", () => renderEditing());
      wrap.appendChild(renameBtn);

      if (state.orders.length > 1) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "tab-icon danger";
        delBtn.setAttribute("aria-label", "Sammelbestellung löschen");
        delBtn.innerHTML = ICONS.xTiny;
        delBtn.addEventListener("click", () => {
          showConfirmDialog({
            title: "Sammelbestellung löschen?",
            message: `"${order.title}" wird endgültig gelöscht, inklusive aller enthaltenen Produkte. Das kann nicht rückgängig gemacht werden.`,
            confirmLabel: "Endgültig löschen",
            onConfirm: () => {
              const idx = state.orders.findIndex((o) => o.id === order.id);
              state.orders = state.orders.filter((o) => o.id !== order.id);
              if (state.activeId === order.id) {
                const fallback = state.orders[Math.max(0, idx - 1)] || state.orders[0];
                state.activeId = fallback.id;
              }
              formOpen = false;
              editingProductId = null;
              render();
              persist();
            },
          });
        });
        wrap.appendChild(delBtn);
      }
    }

    function renderEditing() {
      wrap.innerHTML = "";
      wrap.className = "tab tab-editing";
      wrap.style.padding = "4px";
      const input = document.createElement("input");
      input.className = "tab-input";
      input.value = order.title;
      wrap.appendChild(input);
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);

      function confirm() {
        const trimmed = input.value.trim();
        if (trimmed) order.title = trimmed;
        wrap.style.padding = "";
        renderNormal();
        persist();
      }

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") confirm();
        if (e.key === "Escape") {
          wrap.style.padding = "";
          renderNormal();
        }
      });
      input.addEventListener("blur", confirm);
    }

    renderNormal();
    return wrap;
  }

  function renderPeopleManagerSection() {
    const section = document.createElement("section");
    section.className = "section";

    const head = document.createElement("div");
    head.className = "section-head";
    head.innerHTML = `<h2>${ICONS.users}Personen</h2>`;

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "btn secondary small";
    toggleBtn.textContent = peopleManagerOpen ? "Schließen" : "Verwalten";
    toggleBtn.addEventListener("click", () => {
      peopleManagerOpen = !peopleManagerOpen;
      newPersonInputValue = "";
      render();
    });
    head.appendChild(toggleBtn);
    section.appendChild(head);

    if (peopleManagerOpen) {
      const card = document.createElement("div");
      card.className = "form-card";

      const hint = document.createElement("div");
      hint.className = "shipping-hint";
      hint.style.margin = "0 0 4px";
      hint.textContent = "Beim Entfernen wird die Person auch aus allen Produkten in allen Sammelbestellungen ausgetragen.";
      card.appendChild(hint);

      const chipsRow = document.createElement("div");
      chipsRow.className = "chips-row";
      state.people.forEach((p) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = p + " ";
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "chip-remove";
        rm.setAttribute("aria-label", `${p} entfernen`);
        rm.innerHTML = ICONS.x;
        rm.addEventListener("click", () => {
          showConfirmDialog({
            title: "Person entfernen?",
            message: `"${p}" wird aus der Personenliste entfernt und aus allen Produkten in allen Sammelbestellungen ausgetragen. Das kann nicht rückgängig gemacht werden.`,
            confirmLabel: "Entfernen",
            onConfirm: () => {
              removePerson(p);
              render();
              persist();
            },
          });
        });
        chip.appendChild(rm);
        chipsRow.appendChild(chip);
      });
      card.appendChild(chipsRow);

      const addRow = document.createElement("div");
      addRow.className = "add-row";
      const input = document.createElement("input");
      input.className = "add-input";
      input.placeholder = "Neue Person…";
      input.value = newPersonInputValue;
      input.addEventListener("input", (e) => {
        newPersonInputValue = e.target.value;
      });
      addRow.appendChild(input);

      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "icon-btn confirm";
      confirmBtn.setAttribute("aria-label", "Person hinzufügen");
      confirmBtn.innerHTML = ICONS.check;
      addRow.appendChild(confirmBtn);

      function confirmAdd() {
        const trimmed = newPersonInputValue.trim();
        if (trimmed) {
          addPerson(trimmed);
          newPersonInputValue = "";
          render();
          persist();
        }
      }
      confirmBtn.addEventListener("click", confirmAdd);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") confirmAdd();
      });

      card.appendChild(addRow);
      section.appendChild(card);
    }

    return section;
  }

  function renderPriceListSection(order) {
    const section = document.createElement("section");
    section.className = "section";

    const head = document.createElement("div");
    head.className = "section-head";
    head.innerHTML = `<h2>Preisliste</h2>`;
    section.appendChild(head);

    const summary = document.createElement("div");
    summary.className = "pricelist-summary";

    const text = document.createElement("div");
    text.className = "pricelist-summary-text";
    if (order.priceList.length > 0) {
      text.innerHTML = `<strong>${order.priceList.length} Produkte</strong> geladen${
        order.priceListName ? ` aus „${esc(order.priceListName)}“` : ""
      }`;
    } else {
      text.textContent = "Noch keine Preisliste hochgeladen.";
    }
    summary.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "pricelist-summary-actions";

    const fileLabel = document.createElement("label");
    fileLabel.className = "file-input-label";
    fileLabel.textContent = order.priceList.length > 0 ? "Ersetzen" : "Hochladen";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".xlsx,.xls";
    fileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handlePriceListFile(order, file);
      e.target.value = "";
    });
    fileLabel.appendChild(fileInput);
    actions.appendChild(fileLabel);

    if (order.priceList.length > 0) {
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "btn secondary small";
      clearBtn.textContent = "Entfernen";
      clearBtn.addEventListener("click", () => {
        showConfirmDialog({
          title: "Preisliste entfernen?",
          message: "Die geladene Preisliste wird entfernt. Bereits hinzugefügte Produkte bleiben erhalten.",
          confirmLabel: "Entfernen",
          onConfirm: () => {
            order.priceList = [];
            order.priceListName = "";
            render();
            persist();
          },
        });
      });
      actions.appendChild(clearBtn);
    }

    summary.appendChild(actions);
    section.appendChild(summary);

    if (priceListError) {
      const err = document.createElement("div");
      err.className = "pricelist-error";
      err.textContent = priceListError;
      section.appendChild(err);
    }

    const hint = document.createElement("div");
    hint.className = "pricelist-hint";
    hint.textContent =
      'Excel-Datei (.xlsx) mit den Spalten "Produkt", "Menge" und "Preis". Beim Eintragen eines Produkts kann dann aus der Liste ausgewählt werden.';
    section.appendChild(hint);

    return section;
  }

  function renderOrderView(order) {
    // Fallback für Sammelbestellungen, die vor dem Rabatt-Feature erstellt
    // wurden (dort existieren order.discount / order.discountEnabled noch nicht).
    if (order.discount == null) order.discount = "";
    if (order.discountEnabled == null) order.discountEnabled = false;
    if (order.priceList == null) order.priceList = [];
    if (order.priceListName == null) order.priceListName = "";

    const frag = document.createDocumentFragment();

    // ---- Personen verwalten ----
    frag.appendChild(renderPeopleManagerSection());

    // ---- Preisliste ----
    frag.appendChild(renderPriceListSection(order));

    // ---- Produkte section ----
    const productsSection = document.createElement("section");
    productsSection.className = "section";

    const productsHead = document.createElement("div");
    productsHead.className = "section-head";
    productsHead.innerHTML = `<h2>Produkte</h2>`;
    if (!formOpen) {
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btn primary small";
      addBtn.innerHTML = `${ICONS.plus}Produkt hinzufügen`;
      addBtn.addEventListener("click", () => {
        formOpen = true;
        editingProductId = null;
        render();
      });
      productsHead.appendChild(addBtn);
    }
    productsSection.appendChild(productsHead);

    if (formOpen) {
      const editingProduct = order.products.find((p) => p.id === editingProductId) || null;
      productsSection.appendChild(renderProductForm(order, editingProduct));
    }

    if (order.products.length === 0 && !formOpen) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Noch keine Produkte eingetragen.";
      productsSection.appendChild(empty);
    } else if (order.products.length > 0) {
      const list = document.createElement("div");
      list.className = "product-list";
      order.products.forEach((p) => list.appendChild(renderProductRow(order, p)));
      productsSection.appendChild(list);
    }

    frag.appendChild(productsSection);

    // ---- Wer zahlt wie viel ----
    const perPersonTotals = computePerPersonTotals(order);
    const discountNum = order.discountEnabled ? (parseFloat(String(order.discount).replace(",", ".")) || 0) : 0;
    const shippingNum = parseFloat(String(order.shipping).replace(",", ".")) || 0;
    const shippingShare = perPersonTotals.length > 0 ? shippingNum / perPersonTotals.length : 0;

    if (order.products.length > 0) {
      const peopleSection = document.createElement("section");
      peopleSection.className = "section";
      peopleSection.innerHTML = `<div class="section-head"><h2>${ICONS.users}Wer zahlt wie viel</h2></div>`;

      if (discountNum > 0) {
        const discountNote = document.createElement("div");
        discountNote.className = "shipping-hint discount-note";
        discountNote.style.margin = "0 0 10px";
        discountNote.textContent = `Mengenrabatt von ${discountNum}% wurde bereits abgezogen (gilt nicht für Versand).`;
        peopleSection.appendChild(discountNote);
      }

      const list = document.createElement("div");
      list.className = "person-list";
      perPersonTotals.forEach(({ name, amount, rawAmount }) => {
        const line = document.createElement("div");
        line.className = "person-line";
        const shippingHtml =
          shippingNum > 0
            ? `<span class="person-shipping">+ ${currency(shippingShare)} Versand</span>`
            : "";
        const amountHtml =
          rawAmount > amount
            ? `<span class="num-val-old">${currency(rawAmount)}</span><span class="person-amount">${currency(amount)}</span>`
            : `<span class="person-amount">${currency(amount)}</span>`;
        line.innerHTML = `
          <span class="person-name">${esc(name)}</span>
          <div class="person-amount-block">
            ${amountHtml}
            ${shippingHtml}
          </div>
        `;
        list.appendChild(line);
      });
      peopleSection.appendChild(list);
      frag.appendChild(peopleSection);
    }

    // ---- Versand ----
    const shippingSection = document.createElement("section");
    shippingSection.className = "section";
    shippingSection.innerHTML = `<div class="section-head"><h2>Versand</h2></div>`;

    const shippingRow = document.createElement("div");
    shippingRow.className = "shipping-row";
    shippingRow.id = "shipping-row";
    shippingRow.innerHTML = `<span class="shipping-label">Versandkosten ($)</span>`;
    const shippingInput = document.createElement("input");
    shippingInput.className = "text-input shipping-input";
    shippingInput.inputMode = "decimal";
    shippingInput.value = order.shipping;
    shippingInput.addEventListener("input", (e) => {
      const v = e.target.value;
      if (/^[0-9]*[.,]?[0-9]{0,2}$/.test(v)) {
        order.shipping = v;
        persist();
        renderTotalsOnly(order);
      } else {
        e.target.value = order.shipping;
      }
    });
    shippingRow.appendChild(shippingInput);
    shippingSection.appendChild(shippingRow);

    if (shippingNum > 0 && perPersonTotals.length > 0) {
      const hint = document.createElement("div");
      hint.className = "shipping-hint";
      hint.textContent = `Wird gleichmäßig auf ${perPersonTotals.length} ${
        perPersonTotals.length === 1 ? "Person" : "Personen"
      } aufgeteilt: ${currency(shippingShare)} pro Person.`;
      shippingSection.appendChild(hint);
    }

    frag.appendChild(shippingSection);

    // ---- Mengenrabatt (optional) ----
    const discountSection = document.createElement("section");
    discountSection.className = "section";

    const discountHead = document.createElement("div");
    discountHead.className = "section-head";
    discountHead.innerHTML = `<h2>Mengenrabatt</h2>`;

    const discountToggle = document.createElement("button");
    discountToggle.type = "button";
    discountToggle.className = "switch" + (order.discountEnabled ? " on" : "");
    discountToggle.setAttribute("role", "switch");
    discountToggle.setAttribute("aria-checked", String(order.discountEnabled));
    discountToggle.innerHTML = `<span class="switch-knob"></span>`;
    discountToggle.addEventListener("click", () => {
      order.discountEnabled = !order.discountEnabled;
      if (!order.discountEnabled) order.discount = "";
      persist();
      render();
    });
    discountHead.appendChild(discountToggle);
    discountSection.appendChild(discountHead);

    if (order.discountEnabled) {
      const discountRow = document.createElement("div");
      discountRow.className = "shipping-row";
      discountRow.innerHTML = `<span class="shipping-label">Rabatt (%)</span>`;
      const discountInput = document.createElement("input");
      discountInput.className = "text-input shipping-input";
      discountInput.inputMode = "decimal";
      discountInput.placeholder = "z. B. 15";
      discountInput.value = order.discount;
      discountInput.addEventListener("input", (e) => {
        const v = e.target.value;
        if (/^[0-9]*[.,]?[0-9]{0,2}$/.test(v)) {
          order.discount = v;
          persist();
          renderDiscountEffects(order);
        } else {
          e.target.value = order.discount;
        }
      });
      discountRow.appendChild(discountInput);
      discountSection.appendChild(discountRow);

      const discountHint = document.createElement("div");
      discountHint.className = "shipping-hint";
      discountHint.textContent = "Wird nur von den Pro-Person-Beträgen abgezogen, nicht vom Versand und nicht in der Produktliste.";
      discountSection.appendChild(discountHint);
    }

    frag.appendChild(discountSection);

    // ---- Total bar ----
    frag.appendChild(renderTotalBar(order));

    return frag;
  }

  function getDiscountFactor(order) {
    if (!order.discountEnabled) return 1;
    const discountNum = parseFloat(String(order.discount).replace(",", ".")) || 0;
    return discountNum > 0 ? 1 - Math.min(discountNum, 100) / 100 : 1;
  }

  function computePerPersonTotals(order) {
    const factor = getDiscountFactor(order);
    const map = {};
    const rawMap = {};
    for (const p of order.products) {
      const discountedPrice = p.price * factor;
      const total = discountedPrice * p.qty;
      const rawTotal = p.price * p.qty;
      const share = total / p.participants.length;
      const rawShare = rawTotal / p.participants.length;
      for (const person of p.participants) {
        map[person] = (map[person] || 0) + share;
        rawMap[person] = (rawMap[person] || 0) + rawShare;
      }
    }
    return Object.entries(map)
      .map(([name, amount]) => ({ name, amount, rawAmount: rawMap[name] }))
      .sort((a, b) => b.amount - a.amount);
  }

  function renderTotalBar(order) {
    const factor = getDiscountFactor(order);
    const subtotal = order.products.reduce((sum, p) => sum + p.price * p.qty, 0);
    const discountedSubtotal = subtotal * factor;
    const shippingNum = parseFloat(String(order.shipping).replace(",", ".")) || 0;
    const total = subtotal + shippingNum;
    const discountedTotal = discountedSubtotal + shippingNum;

    const subtotalHtml =
      factor < 1
        ? `<span class="total-old">${currency(subtotal)}</span> ${currency(discountedSubtotal)}`
        : currency(subtotal);
    const totalHtml =
      factor < 1
        ? `<span class="total-old">${currency(total)}</span> ${currency(discountedTotal)}`
        : currency(total);

    const bar = document.createElement("div");
    bar.className = "total-bar";
    bar.id = "total-bar";
    bar.innerHTML = `
      <div class="total-line">
        <span>Gesamt ohne Versand</span>
        <strong>${subtotalHtml}</strong>
      </div>
      <div class="total-line main">
        <span>Gesamtsumme</span>
        <strong>${totalHtml}</strong>
      </div>
    `;
    return bar;
  }

  function renderDiscountEffects(order) {
    // Aktualisiert alles, was vom Rabatt betroffen ist (Produktzeilen,
    // Personenliste, Totalbar), OHNE das Rabatt-Eingabefeld selbst neu zu
    // erzeugen - so bleibt der Fokus (und damit die Tastatur) erhalten.

    // Produktzeilen ersetzen
    const list = document.querySelector(".product-list");
    if (list) {
      const newList = document.createElement("div");
      newList.className = "product-list";
      order.products.forEach((p) => newList.appendChild(renderProductRow(order, p)));
      list.replaceWith(newList);
    }

    // Rabatt-Hinweistext oben in "Wer zahlt wie viel"
    const discountNum = order.discountEnabled ? (parseFloat(String(order.discount).replace(",", ".")) || 0) : 0;
    const discountNoteExisting = document.querySelector(".discount-note");
    if (discountNum > 0) {
      const text = `Mengenrabatt von ${discountNum}% wurde bereits abgezogen (gilt nicht für Versand).`;
      if (discountNoteExisting) {
        discountNoteExisting.textContent = text;
      } else {
        const peopleSection = document.querySelector(".person-list")?.parentElement;
        if (peopleSection) {
          const note = document.createElement("div");
          note.className = "shipping-hint discount-note";
          note.style.margin = "0 0 10px";
          note.textContent = text;
          peopleSection.insertBefore(note, peopleSection.querySelector(".person-list"));
        }
      }
    } else if (discountNoteExisting) {
      discountNoteExisting.remove();
    }

    // Personenbeträge + Totalbar (bestehende Logik)
    renderTotalsOnly(order);
  }

  function renderTotalsOnly(order) {
    // Lightweight refresh for shipping input changes without losing focus / full re-render
    const oldBar = document.getElementById("total-bar");
    if (oldBar) oldBar.replaceWith(renderTotalBar(order));

    // Update person shipping shares text without full re-render
    const perPersonTotals = computePerPersonTotals(order);
    const shippingNum = parseFloat(String(order.shipping).replace(",", ".")) || 0;
    const shippingShare = perPersonTotals.length > 0 ? shippingNum / perPersonTotals.length : 0;

    document.querySelectorAll(".person-list .person-line").forEach((line, idx) => {
      const entry = perPersonTotals[idx];
      if (!entry) return;
      const block = line.querySelector(".person-amount-block");
      if (!block) return;
      const shippingHtml =
        shippingNum > 0
          ? `<span class="person-shipping">+ ${currency(shippingShare)} Versand</span>`
          : "";
      const amountHtml =
        entry.rawAmount > entry.amount
          ? `<span class="num-val-old">${currency(entry.rawAmount)}</span><span class="person-amount">${currency(entry.amount)}</span>`
          : `<span class="person-amount">${currency(entry.amount)}</span>`;
      block.innerHTML = `${amountHtml}${shippingHtml}`;
    });

    const hintExisting = document.querySelector(".shipping-hint");
    if (shippingNum > 0 && perPersonTotals.length > 0) {
      const text = `Wird gleichmäßig auf ${perPersonTotals.length} ${
        perPersonTotals.length === 1 ? "Person" : "Personen"
      } aufgeteilt: ${currency(shippingShare)} pro Person.`;
      if (hintExisting) {
        hintExisting.textContent = text;
      } else {
        const shippingSection = document.getElementById("shipping-row").parentElement;
        const hint = document.createElement("div");
        hint.className = "shipping-hint";
        hint.textContent = text;
        shippingSection.appendChild(hint);
      }
    } else if (hintExisting) {
      hintExisting.remove();
    }
  }

  function renderProductRow(order, product) {
    const row = document.createElement("div");
    row.className = "product-row";
    const factor = getDiscountFactor(order);
    const discountedPrice = product.price * factor;
    const total = discountedPrice * product.qty;
    const perPerson = total / product.participants.length;

    const priceHtml =
      factor < 1
        ? `<span class="num-val-old">${currency(product.price)}</span><span class="num-val">${currency(discountedPrice)}</span>`
        : `<span class="num-val">${currency(product.price)}</span>`;

    row.innerHTML = `
      <div class="product-top">
        <div class="product-main">
          <div class="product-name">${product.qty}× ${esc(product.name)}</div>
          <div class="product-people">${esc(product.participants.join(", "))}</div>
        </div>
        <div class="product-actions">
          <button type="button" class="icon-btn-ghost" aria-label="Bearbeiten">${ICONS.pencil}</button>
          <button type="button" class="icon-btn-ghost danger" aria-label="Löschen">${ICONS.trash}</button>
        </div>
      </div>
      <div class="product-bottom">
        <div class="product-nums">
          <div class="num-block">
            <span class="num-label">Stückpreis</span>
            ${priceHtml}
          </div>
          <div class="num-block num-block-total">
            <span class="num-label">Gesamt</span>
            <span class="num-val num-val-total">${currency(total)}</span>
          </div>
          <div class="num-block">
            <span class="num-label">Pro Person</span>
            <span class="num-val accent">${currency(perPerson)}</span>
          </div>
        </div>
      </div>
    `;

    const [editBtn, delBtn] = row.querySelectorAll(".product-actions button");
    editBtn.addEventListener("click", () => {
      editingProductId = product.id;
      formOpen = true;
      render();
    });
    delBtn.addEventListener("click", () => {
      showConfirmDialog({
        title: "Produkt löschen?",
        message: `"${product.name}" wird endgültig aus dieser Sammelbestellung gelöscht. Das kann nicht rückgängig gemacht werden.`,
        confirmLabel: "Endgültig löschen",
        onConfirm: () => {
          order.products = order.products.filter((p) => p.id !== product.id);
          render();
          persist();
        },
      });
    });

    return row;
  }

  function renderProductForm(order, initial) {
    autocompleteOpen = false;
    autocompleteActiveIndex = -1;

    const card = document.createElement("div");
    card.className = "form-card";

    let name = initial?.name ?? "";
    let participants = initial?.participants ? initial.participants.slice() : [];
    let qty = initial?.qty != null ? String(initial.qty) : "1";
    let price = initial?.price != null ? String(initial.price) : "";
    let touched = false;

    function priceInfo() {
      const priceNum = parseFloat(String(price).replace(",", "."));
      const priceValid = price !== "" && !isNaN(priceNum) && priceNum > 0;
      const qtyNum = parseInt(String(qty), 10);
      const qtyValid = qty !== "" && !isNaN(qtyNum) && qtyNum > 0;
      const peopleCount = participants.length;
      const peopleValid = peopleCount > 0;
      const nameValid = name.trim().length > 0;
      const total = priceValid && qtyValid ? priceNum * qtyNum : null;
      const perPerson = total !== null && peopleValid ? total / peopleCount : null;
      const canSave = nameValid && peopleValid && priceValid && qtyValid;
      return { priceNum, priceValid, qtyNum, qtyValid, peopleCount, peopleValid, nameValid, total, perPerson, canSave };
    }

    // --- Produkt name field (mit Autofill aus Preisliste) ---
    const nameField = document.createElement("div");
    nameField.className = "field";
    nameField.innerHTML = `<label class="label">Produkt</label>`;
    const nameWrap = document.createElement("div");
    nameWrap.className = "autocomplete-wrap";
    const nameInput = document.createElement("input");
    nameInput.className = "text-input";
    nameInput.autocomplete = "off";
    nameInput.value = name;
    nameWrap.appendChild(nameInput);
    const autocompleteList = document.createElement("div");
    autocompleteList.className = "autocomplete-list";
    autocompleteList.style.display = "none";
    nameWrap.appendChild(autocompleteList);
    nameField.appendChild(nameWrap);
    const nameErr = document.createElement("div");
    nameErr.className = "err";
    nameErr.style.display = "none";
    nameErr.textContent = "Bitte einen Produktnamen eingeben.";
    nameField.appendChild(nameErr);
    card.appendChild(nameField);

    function applyAutocompleteItem(item) {
      name = item.name;
      nameInput.value = item.name;
      price = String(item.price);
      priceInput.value = price;
      if (item.qty != null) {
        qty = String(item.qty);
        qtyInput.value = qty;
      }
      closeAutocomplete();
      updateValidation();
      updateCountAndPreview();
      nameInput.focus();
    }

    function closeAutocomplete() {
      autocompleteOpen = false;
      autocompleteActiveIndex = -1;
      autocompleteList.style.display = "none";
      autocompleteList.innerHTML = "";
    }

    function renderAutocomplete() {
      const matches = matchPriceListItems(order, name);
      if (matches.length === 0) {
        closeAutocomplete();
        return;
      }
      autocompleteOpen = true;
      if (autocompleteActiveIndex >= matches.length) autocompleteActiveIndex = -1;
      autocompleteList.innerHTML = "";
      matches.forEach((item, idx) => {
        const row = document.createElement("div");
        row.className = "autocomplete-item" + (idx === autocompleteActiveIndex ? " active" : "");
        row.innerHTML = `
          <span class="autocomplete-item-name">
            ${esc(item.name)}
          </span>
          <span class="autocomplete-item-meta">${currency(item.price)}</span>
        `;
        row.addEventListener("mousedown", (e) => {
          // mousedown statt click, damit es vor dem blur des Inputs feuert
          e.preventDefault();
          applyAutocompleteItem(item);
        });
        autocompleteList.appendChild(row);
      });
      autocompleteList.style.display = "block";
    }

    nameInput.addEventListener("input", (e) => {
      name = e.target.value;
      autocompleteActiveIndex = -1;
      updateValidation();
      renderAutocomplete();
    });
    nameInput.addEventListener("focus", () => {
      if (name.trim()) renderAutocomplete();
    });
    nameInput.addEventListener("blur", () => {
      // kleine Verzögerung, damit ein mousedown auf einem Listeneintrag noch
      // greifen kann, bevor die Liste verschwindet
      setTimeout(closeAutocomplete, 100);
    });
    nameInput.addEventListener("keydown", (e) => {
      if (!autocompleteOpen) return;
      const items = autocompleteList.querySelectorAll(".autocomplete-item");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        autocompleteActiveIndex = Math.min(autocompleteActiveIndex + 1, items.length - 1);
        renderAutocomplete();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        autocompleteActiveIndex = Math.max(autocompleteActiveIndex - 1, 0);
        renderAutocomplete();
      } else if (e.key === "Enter") {
        if (autocompleteActiveIndex >= 0) {
          e.preventDefault();
          const matches = matchPriceListItems(order, name);
          const item = matches[autocompleteActiveIndex];
          if (item) applyAutocompleteItem(item);
        }
      } else if (e.key === "Escape") {
        closeAutocomplete();
      }
    });

    // --- Beteiligung field ---
    const participantsField = document.createElement("div");
    participantsField.className = "field";
    participantsField.innerHTML = `<label class="label">Beteiligung — wer zahlt mit?</label>`;
    const pickerWrap = document.createElement("div");
    participantsField.appendChild(pickerWrap);
    const participantsErr = document.createElement("div");
    participantsErr.className = "err";
    participantsErr.style.display = "none";
    participantsErr.textContent = "Mindestens eine Person auswählen.";
    participantsField.appendChild(participantsErr);
    card.appendChild(participantsField);

    function renderPicker() {
      pickerWrap.innerHTML = "";

      const chipsRow = document.createElement("div");
      chipsRow.className = "chips-row";
      participants.forEach((p) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = p + " ";
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "chip-remove";
        rm.setAttribute("aria-label", `${p} entfernen`);
        rm.innerHTML = ICONS.x;
        rm.addEventListener("click", () => {
          participants = participants.filter((n) => n !== p);
          renderPicker();
          updateValidation();
          updateCountAndPreview();
        });
        chip.appendChild(rm);
        chipsRow.appendChild(chip);
      });
      pickerWrap.appendChild(chipsRow);

      if (personPickerAdding) {
        const addRow = document.createElement("div");
        addRow.className = "add-row";
        const input = document.createElement("input");
        input.className = "add-input";
        addRow.appendChild(input);

        const confirmBtn = document.createElement("button");
        confirmBtn.type = "button";
        confirmBtn.className = "icon-btn confirm";
        confirmBtn.setAttribute("aria-label", "Hinzufügen bestätigen");
        confirmBtn.innerHTML = ICONS.check;
        addRow.appendChild(confirmBtn);

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "icon-btn cancel";
        cancelBtn.setAttribute("aria-label", "Abbrechen");
        cancelBtn.innerHTML = ICONS.x;
        addRow.appendChild(cancelBtn);

        pickerWrap.appendChild(addRow);
        setTimeout(() => input.focus(), 0);

        function confirmAdd() {
          const trimmed = input.value.trim();
          personPickerAdding = false;
          if (trimmed) {
            addPerson(trimmed);
            if (!participants.includes(trimmed)) participants.push(trimmed);
          }
          renderPicker();
          updateValidation();
          updateCountAndPreview();
        }

        confirmBtn.addEventListener("click", confirmAdd);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") confirmAdd();
          if (e.key === "Escape") {
            personPickerAdding = false;
            renderPicker();
          }
        });
        cancelBtn.addEventListener("click", () => {
          personPickerAdding = false;
          renderPicker();
        });
      } else {
        const select = document.createElement("select");
        select.className = "select";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.disabled = true;
        placeholder.selected = true;
        placeholder.textContent = "+ Person hinzufügen…";
        select.appendChild(placeholder);

        state.people
          .filter((p) => !participants.includes(p))
          .forEach((p) => {
            const opt = document.createElement("option");
            opt.value = p;
            opt.textContent = p;
            select.appendChild(opt);
          });

        const addOpt = document.createElement("option");
        addOpt.value = "__add__";
        addOpt.textContent = "✦ Neue Person…";
        select.appendChild(addOpt);

        select.addEventListener("change", (e) => {
          const val = e.target.value;
          if (val === "__add__") {
            personPickerAdding = true;
            renderPicker();
            return;
          }
          if (val) {
            participants.push(val);
            renderPicker();
            updateValidation();
            updateCountAndPreview();
          }
        });

        pickerWrap.appendChild(select);
      }
    }
    renderPicker();

    // --- Row 2: Anzahl (editierbar) + Stückpreis ---
    const row2 = document.createElement("div");
    row2.className = "row-2";

    const qtyField = document.createElement("div");
    qtyField.className = "field";
    qtyField.innerHTML = `<label class="label">Anzahl</label>`;
    const qtyInput = document.createElement("input");
    qtyInput.className = "text-input price-input";
    qtyInput.inputMode = "numeric";
    qtyInput.value = qty;
    qtyInput.addEventListener("input", (e) => {
      const v = e.target.value;
      if (/^[0-9]*$/.test(v)) {
        qty = v;
      } else {
        e.target.value = qty;
      }
      updateValidation();
      updateCountAndPreview();
    });
    qtyField.appendChild(qtyInput);
    const qtyErr = document.createElement("div");
    qtyErr.className = "err";
    qtyErr.style.display = "none";
    qtyErr.textContent = "Gültige Anzahl eingeben.";
    qtyField.appendChild(qtyErr);
    row2.appendChild(qtyField);

    const priceField = document.createElement("div");
    priceField.className = "field";
    priceField.innerHTML = `<label class="label">Stückpreis ($)</label>`;
    const priceInput = document.createElement("input");
    priceInput.className = "text-input price-input";
    priceInput.inputMode = "decimal";
    priceInput.value = price;
    priceInput.addEventListener("input", (e) => {
      const v = e.target.value;
      if (/^[0-9]*[.,]?[0-9]{0,2}$/.test(v)) {
        price = v;
      } else {
        e.target.value = price;
      }
      updateValidation();
      updateCountAndPreview();
    });
    priceField.appendChild(priceInput);
    const priceErr = document.createElement("div");
    priceErr.className = "err";
    priceErr.style.display = "none";
    priceErr.textContent = "Gültigen Preis eingeben.";
    priceField.appendChild(priceErr);
    row2.appendChild(priceField);

    card.appendChild(row2);

    // --- Preview: Gesamt + Preis pro Person ---
    const preview = document.createElement("div");
    preview.className = "per-person-preview";
    preview.innerHTML = `<span>Gesamt / Pro Person</span><strong>— / —</strong>`;
    card.appendChild(preview);

    function updateCountAndPreview() {
      const info = priceInfo();
      const totalText = info.total !== null ? currency(info.total) : "—";
      const perPersonText = info.perPerson !== null ? currency(info.perPerson) : "—";
      preview.querySelector("strong").textContent = `${totalText} / ${perPersonText}`;
    }
    updateCountAndPreview();

    function updateValidation() {
      if (!touched) return;
      const info = priceInfo();
      nameErr.style.display = info.nameValid ? "none" : "block";
      participantsErr.style.display = participants.length > 0 ? "none" : "block";
      qtyErr.style.display = info.qtyValid ? "none" : "block";
      priceErr.style.display = info.priceValid ? "none" : "block";
    }

    // --- Actions ---
    const actions = document.createElement("div");
    actions.className = "form-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn secondary form-btn";
    cancelBtn.textContent = "Abbrechen";
    cancelBtn.addEventListener("click", () => {
      formOpen = false;
      editingProductId = null;
      personPickerAdding = false;
      render();
    });
    actions.appendChild(cancelBtn);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn primary form-btn";
    saveBtn.textContent = initial ? "Änderungen speichern" : "Produkt hinzufügen";
    saveBtn.addEventListener("click", () => {
      touched = true;
      updateValidation();
      const info = priceInfo();
      if (!info.canSave) return;

      const product = {
        id: initial?.id ?? uid(),
        name: name.trim(),
        participants: participants.slice(),
        qty: info.qtyNum,
        price: Math.round(info.priceNum * 100) / 100,
      };

      const exists = order.products.some((p) => p.id === product.id);
      if (exists) {
        order.products = order.products.map((p) => (p.id === product.id ? product : p));
      } else {
        order.products.push(product);
      }

      formOpen = false;
      editingProductId = null;
      personPickerAdding = false;
      render();
      persist();
    });
    actions.appendChild(saveBtn);

    card.appendChild(actions);

    return card;
  }

  // ---------- Init ----------
  render(); // sofort mit lokalem/leerem State zeichnen, damit UI nicht leer bleibt
  initialLoad(); // dann echten State vom Server laden und ggf. neu zeichnen

  // ---------- Service worker registration ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {
        /* offline support unavailable */
      });
    });
  }
})();

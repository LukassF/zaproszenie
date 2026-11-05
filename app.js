(() => {
  "use strict";

  const cfg = window.RSVP_CONFIG || {};
  const DEADLINE = new Date(cfg.deadline || "2027-06-30T23:59:59+02:00");
  const PHONES =
    'Ania: <a href="tel:+48518686497">518 686 497</a>, Łukasz: <a href="tel:+48798767199">798 767 199</a>';

  const DIETS = [
    ["standard", "Standardowa"],
    ["vegetarian", "Wegetariańska"],
    ["vegan", "Wegańska"],
    ["gluten_free", "Bezglutenowa"],
    ["other", "Inna (opisz w uwagach)"],
  ];
  const dietLabel = (key) => (DIETS.find(([k]) => k === key) || DIETS[0])[1];
  // "+1" w kolumnie "osoby" = osoba towarzysząca, która sama wpisuje imię i nazwisko
  const isPlusSlot = (name) => /^\+\s*1$/.test(String(name).trim());
  const guestLabel = (g) =>
    isPlusSlot(g.name)
      ? g.fullName
        ? `${g.fullName} (osoba towarzysząca)`
        : "Osoba towarzysząca"
      : g.name;
  const MAX_CHILDREN = 6;
  const TRANSPORT_INFO =
    "Zapewniamy zorganizowany transport dla gości. Liczba miejsc parkingowych jest ograniczona, dlatego bardzo prosimy o skorzystanie z niego zamiast przyjazdu własnym samochodem.";

  const $ = (sel) => document.querySelector(sel);
  const statusEl = $("#rsvp-status");
  const summaryEl = $("#rsvp-summary");
  const form = $("#rsvp-form");

  const token = (new URLSearchParams(location.search).get("t") || "").trim();

  // ---------- Tryb demo: ?t=demo, demo-solo, demo-plain, demo-locked ----------

  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost|)$/.test(
    location.hostname,
  );
  const DEMO = {
    demo: {
      displayName: "Lucynę i Michała Foberów",
      guests: ["Lucyna", "Michał"],
      flags: { accommodation: true, plusOne: false, children: true },
    },
    "demo-solo": {
      displayName: "Pana Jana Kowalskiego",
      guests: ["Jan"],
      flags: { accommodation: false, plusOne: true, children: false },
    },
    "demo-plus1": {
      displayName: "Lubomira Jachowicza z Osobą Towarzyszącą",
      guests: ["Lubomir Jachowicz", "+1"],
      flags: { accommodation: false, plusOne: false, children: false },
    },
    "demo-plain": {
      displayName: "Lucynę i Michała Foberów",
      guests: ["Lucyna", "Michał"],
      flags: { accommodation: false, plusOne: false, children: false },
    },
    "demo-locked": {
      displayName: "Lucynę i Michała Foberów",
      guests: ["Lucyna", "Michał"],
      flags: { accommodation: true, plusOne: false, children: false },
      locked: true,
      response: {
        guests: [
          {
            name: "Lucyna",
            attending: true,
            diet: "vegetarian",
            allergies: "orzechy",
          },
          { name: "Michał", attending: false },
        ],
        accommodation: true,
        comment: "",
      },
      updatedAt: "2027-05-02T18:20:00Z",
    },
  };
  const demoStore = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const api = {
    async load(t) {
      if (isLocal && DEMO[t]) {
        await sleep(1500); // jak prawdziwy backend — widać loader
        return {
          ok: true,
          locked: false,
          response: null,
          updatedAt: null,
          ...DEMO[t],
          ...demoStore[t],
        };
      }
      if (!cfg.scriptUrl) throw new Error("Brak scriptUrl w config.js");
      const res = await fetch(`${cfg.scriptUrl}?t=${encodeURIComponent(t)}`);
      return res.json();
    },
    async save(payload) {
      if (isLocal && DEMO[payload.token]) {
        await sleep(600);
        const updatedAt = new Date().toISOString();
        demoStore[payload.token] = { response: payload, updatedAt };
        return { ok: true, updatedAt };
      }
      // text/plain = "simple request", więc przeglądarka nie wysyła preflightu, którego Apps Script nie obsługuje
      const res = await fetch(cfg.scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      return res.json();
    },
  };

  // ---------- Pomocnicze ----------

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  function pills(name, options, required = true) {
    return h(
      "div",
      { class: "pills", role: "radiogroup" },
      options.map(([value, label], i) =>
        h(
          "label",
          { class: "pill" },
          h("input", {
            type: "radio",
            name,
            value,
            required: required && i === 0,
          }),
          h("span", {}, label),
        ),
      ),
    );
  }

  const radioValue = (name) =>
    (form.querySelector(`input[name="${name}"]:checked`) || {}).value;
  function setRadio(name, value) {
    const el = form.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  }

  function dietFields(prefix) {
    return h(
      "div",
      { class: "row" },
      h(
        "label",
        { class: "field" },
        h("span", {}, "Dieta"),
        h(
          "select",
          { name: `${prefix}-diet` },
          DIETS.map(([v, l]) => h("option", { value: v }, l)),
        ),
      ),
      h(
        "label",
        { class: "field" },
        h("span", {}, "Alergie / uwagi"),
        h("input", {
          type: "text",
          name: `${prefix}-allergies`,
          maxlength: 300,
          autocomplete: "off",
        }),
      ),
    );
  }

  const fmtDate = (iso) =>
    new Date(iso).toLocaleString("pl-PL", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  // Nazwa gościa: zapamiętana w przeglądarce, żeby przy kolejnych wejściach była od razu
  const NAME_KEY = `rsvp-name:${token}`;
  const storage = {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch (_) {
        return null;
      }
    },
    set: (k, v) => {
      try {
        if (v == null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch (_) {
        /* prywatne okno / zablokowane dane strony — działamy bez pamięci */
      }
    },
  };

  // fresh: nazwa zastępuje kropki ładowania, więc wyłania się z animacją
  function showGuest(displayName, fresh = false) {
    const nameEl = $("#guest-name");
    if (fresh && nameEl.querySelector(".dots"))
      $("#guest").classList.add("is-new");
    nameEl.textContent = displayName.toUpperCase();
    $("#guest").hidden = false;
  }
  const dots = () =>
    h("span", { class: "dots", "aria-hidden": "true" }, h("i"), h("i"), h("i"));
  const hideGuest = () => {
    $("#guest").hidden = true;
  };

  function showStatus(html, error = false) {
    statusEl.innerHTML = html;
    statusEl.classList.toggle("note--error", error);
    statusEl.hidden = false;
  }

  // ---------- Formularz ----------

  let invite = null;

  function buildForm() {
    const many = invite.guests.length > 1;
    const f = invite.flags;
    form.replaceChildren();

    invite.guests.forEach((name, i) => {
      form.append(
        h(
          "fieldset",
          { class: "person", "data-i": i },
          i === 0
            ? h(
                "legend",
                {},
                many ? "Kto z Was będzie z nami?" : "Czy będziesz z nami?",
              )
            : null,
          h(
            "div",
            { class: "person__name" },
            isPlusSlot(name) ? "Osoba towarzysząca" : name,
          ),
          pills(
            `att-${i}`,
            many
              ? [
                  ["yes", "Przyjdzie"],
                  ["no", "Nie przyjdzie"],
                ]
              : [
                  ["yes", "Przyjdę"],
                  ["no", "Nie przyjdę"],
                ],
          ),
          h(
            "div",
            { class: "person__diet stack", "data-when": "self" },
            isPlusSlot(name)
              ? h(
                  "label",
                  { class: "field" },
                  h("span", {}, "Imię i nazwisko"),
                  h("input", {
                    type: "text",
                    name: `p${i}-name`,
                    maxlength: 100,
                    required: true,
                    autocomplete: "off",
                  }),
                )
              : null,
            dietFields(`p${i}`),
          ),
        ),
      );
    });

    if (f.plusOne) {
      form.append(
        h(
          "fieldset",
          { "data-when": "any" },
          h("legend", {}, "Osoba towarzysząca"),
          pills(
            "plus",
            many
              ? [
                  ["yes", "Przyjdziemy z osobą towarzyszącą"],
                  ["no", "Bez osoby towarzyszącej"],
                ]
              : [
                  ["yes", "Przyjdę z osobą towarzyszącą"],
                  ["no", "Przyjdę sam/sama"],
                ],
          ),
          h(
            "div",
            { class: "stack", "data-when": "plus" },
            h(
              "label",
              { class: "field" },
              h("span", {}, "Imię i nazwisko"),
              h("input", {
                type: "text",
                name: "plus-name",
                maxlength: 100,
                required: true,
                autocomplete: "off",
              }),
            ),
            dietFields("plus"),
          ),
        ),
      );
    }

    if (f.children) {
      const count = h(
        "select",
        { name: "kids" },
        Array.from({ length: MAX_CHILDREN + 1 }, (_, n) =>
          h("option", { value: n }, n === 0 ? "Bez dzieci" : String(n)),
        ),
      );
      form.append(
        h(
          "fieldset",
          { "data-when": "any" },
          h("legend", {}, "Dzieci"),
          h("label", { class: "field" }, h("span", {}, "Liczba dzieci"), count),
          h("div", { class: "ages", id: "ages" }),
        ),
      );
      count.addEventListener("change", renderAges);
    }

    form.append(
      h(
        "fieldset",
        { "data-when": "any" },
        h("legend", {}, "Dojazd"),
        h("p", { class: "info" }, TRANSPORT_INFO),
      ),
    );

    if (f.accommodation) {
      form.append(
        h(
          "fieldset",
          { "data-when": "any" },
          h("legend", {}, "Nocleg"),
          pills(
            "stay",
            many
              ? [
                  ["yes", "Chcemy skorzystać z noclegu"],
                  ["no", "Nie potrzebujemy noclegu"],
                ]
              : [
                  ["yes", "Chcę skorzystać z noclegu"],
                  ["no", "Nie potrzebuję noclegu"],
                ],
          ),
        ),
      );
    }

    form.append(
      h(
        "label",
        { class: "field" },
        h("span", {}, "Wiadomość dla nas (opcjonalnie)"),
        h("textarea", { name: "comment", maxlength: 1000 }),
      ),
      h("p", { class: "err", id: "form-error", hidden: true }),
      h(
        "button",
        { class: "btn", type: "submit" },
        invite.response ? "Zapisz zmiany" : "Wyślij potwierdzenie",
      ),
    );

    form.addEventListener("change", syncVisibility);
  }

  function renderAges(prev) {
    const box = form.querySelector("#ages");
    const n = Number(form.elements.kids.value);
    const old = [...box.querySelectorAll("input")].map((i) => i.value);
    const values = Array.isArray(prev) ? prev : old;
    box.replaceChildren(
      ...Array.from({ length: n }, (_, i) =>
        h(
          "label",
          { class: "field" },
          h("span", {}, `Wiek dziecka ${n > 1 ? i + 1 : ""}`.trim()),
          h("input", {
            type: "number",
            name: `kid-${i}`,
            min: 0,
            max: 17,
            inputmode: "numeric",
            required: true,
            value: values[i] ?? "",
          }),
        ),
      ),
    );
  }

  // Sekcje zależne od obecności: chowamy i wyłączamy (wyłączone pola nie blokują walidacji)
  function syncVisibility() {
    const anyComing = invite.guests.some(
      (_, i) => radioValue(`att-${i}`) === "yes",
    );
    form
      .querySelectorAll(".person")
      .forEach((fs, i) =>
        toggle(
          fs.querySelector('[data-when="self"]'),
          radioValue(`att-${i}`) === "yes",
        ),
      );
    form
      .querySelectorAll('[data-when="any"]')
      .forEach((el) => toggle(el, anyComing));
    const plus = form.querySelector('[data-when="plus"]');
    if (plus) toggle(plus, anyComing && radioValue("plus") === "yes");
  }
  function toggle(el, on) {
    el.hidden = !on;
    el.querySelectorAll("input, select, textarea").forEach((i) => {
      i.disabled = !on;
    });
  }

  function prefill(r) {
    r.guests.forEach((g, i) => {
      setRadio(`att-${i}`, g.attending ? "yes" : "no");
      if (g.attending) {
        form.elements[`p${i}-diet`].value = g.diet || "standard";
        form.elements[`p${i}-allergies`].value = g.allergies || "";
        if (form.elements[`p${i}-name`])
          form.elements[`p${i}-name`].value = g.fullName || "";
      }
    });
    if (invite.flags.plusOne && r.plusOne) {
      setRadio("plus", r.plusOne.coming ? "yes" : "no");
      if (r.plusOne.coming) {
        form.elements["plus-name"].value = r.plusOne.name || "";
        form.elements["plus-diet"].value = r.plusOne.diet || "standard";
        form.elements["plus-allergies"].value = r.plusOne.allergies || "";
      }
    }
    if (invite.flags.children && r.children) {
      form.elements.kids.value = String(r.children.count);
      renderAges(r.children.ages);
    }
    if (invite.flags.accommodation && typeof r.accommodation === "boolean")
      setRadio("stay", r.accommodation ? "yes" : "no");
    form.elements.comment.value = r.comment || "";
  }

  function collect() {
    const val = (name) =>
      form.elements[name] ? form.elements[name].value.trim() : "";
    const guests = invite.guests.map((name, i) =>
      radioValue(`att-${i}`) === "yes"
        ? {
            name,
            attending: true,
            diet: val(`p${i}-diet`),
            allergies: val(`p${i}-allergies`),
            ...(isPlusSlot(name) && { fullName: val(`p${i}-name`) }),
          }
        : { name, attending: false },
    );
    const any = guests.some((g) => g.attending);
    const out = {
      token,
      guests,
      plusOne: null,
      children: null,
      accommodation: null,
      comment: val("comment"),
    };
    if (any) {
      if (invite.flags.plusOne) {
        out.plusOne =
          radioValue("plus") === "yes"
            ? {
                coming: true,
                name: val("plus-name"),
                diet: val("plus-diet"),
                allergies: val("plus-allergies"),
              }
            : { coming: false };
      }
      if (invite.flags.children) {
        const count = Number(form.elements.kids.value);
        out.children = {
          count,
          ages: Array.from({ length: count }, (_, i) =>
            Number(val(`kid-${i}`)),
          ),
        };
      }
      if (invite.flags.accommodation)
        out.accommodation = radioValue("stay") === "yes";
    }
    return out;
  }

  async function onSubmit(e) {
    e.preventDefault();
    const err = form.querySelector("#form-error");
    err.hidden = true;
    if (!form.checkValidity()) {
      err.textContent = "Uzupełnij proszę zaznaczone pola.";
      err.hidden = false;
      form.reportValidity();
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const label = btn.textContent;
    btn.replaceChildren("Wysyłanie", dots());
    try {
      const payload = collect();
      const res = await api.save(payload);
      if (!res.ok) throw new Error(res.error || "server");
      invite.response = payload;
      invite.updatedAt = res.updatedAt;
      showSummary(true);
    } catch (ex) {
      console.error(ex);
      const msg =
        ex.message === "locked"
          ? `Termin potwierdzeń minął. W razie zmian prosimy o telefon — ${PHONES}.`
          : `Nie udało się wysłać odpowiedzi. Spróbuj ponownie za chwilę albo zadzwoń — ${PHONES}.`;
      err.innerHTML = msg;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ---------- Podsumowanie ----------

  function describe(r) {
    const items = r.guests.map((g) => [
      guestLabel(g),
      g.attending
        ? `będzie · dieta: ${dietLabel(g.diet).toLowerCase()}${g.allergies ? ` (${g.allergies})` : ""}`
        : "nie będzie",
    ]);
    if (r.plusOne) {
      items.push([
        "Osoba towarzysząca",
        r.plusOne.coming
          ? `${r.plusOne.name} · dieta: ${dietLabel(r.plusOne.diet).toLowerCase()}${r.plusOne.allergies ? ` (${r.plusOne.allergies})` : ""}`
          : "brak",
      ]);
    }
    if (r.children)
      items.push([
        "Dzieci",
        r.children.count
          ? `${r.children.count} (wiek: ${r.children.ages.join(", ")})`
          : "brak",
      ]);
    if (typeof r.accommodation === "boolean")
      items.push(["Nocleg", r.accommodation ? "tak" : "nie"]);
    if (r.comment) items.push(["Wiadomość", r.comment]);
    return h(
      "ul",
      {},
      items.map(([k, v]) => h("li", {}, h("b", {}, `${k}: `), v)),
    );
  }

  function showSummary(justSaved = false) {
    const r = invite.response;
    const anyComing = r.guests.some((g) => g.attending);
    const locked = isLocked();
    statusEl.hidden = true;
    form.hidden = true;
    summaryEl.replaceChildren(
      h(
        "div",
        { class: "summary" },
        justSaved
          ? h(
              "p",
              { class: "thanks" },
              anyComing ? "Dziękujemy!" : "Dziękujemy za odpowiedź",
            )
          : null,
        h(
          "h3",
          {},
          justSaved ? "Zapisaliśmy Waszą odpowiedź" : "Wasza odpowiedź",
        ),
        describe(r),
        anyComing ? h("p", { class: "info" }, TRANSPORT_INFO) : null,
        invite.updatedAt
          ? h("p", { class: "meta" }, `Zapisano ${fmtDate(invite.updatedAt)}`)
          : null,
        locked
          ? h("p", {
              class: "meta",
              html: `Termin zmian minął 30 czerwca 2027. Gdyby coś się zmieniło, zadzwoń — ${PHONES}.`,
            })
          : h(
              "button",
              { class: "btn btn--ghost", type: "button", onclick: editAgain },
              "Zmień odpowiedź",
            ),
      ),
    );
    summaryEl.hidden = false;
  }

  function editAgain() {
    summaryEl.hidden = true;
    form.hidden = false;
    form.querySelector('button[type="submit"]').textContent = "Zapisz zmiany";
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const isLocked = () =>
    Boolean(invite && invite.locked) || Date.now() > DEADLINE.getTime();

  // ---------- Start ----------

  async function init() {
    if (!token) {
      hideGuest();
      showStatus(
        "Aby potwierdzić przybycie, otwórz osobisty link lub zeskanuj kod QR z zaproszenia. Możesz też zadzwonić — numery poniżej.",
      );
      return;
    }
    const cachedName = storage.get(NAME_KEY);
    if (cachedName) showGuest(cachedName);

    let data;
    try {
      data = await api.load(token);
    } catch (ex) {
      console.error(ex);
      if (!cachedName) hideGuest();
      showStatus(
        `Nie udało się wczytać zaproszenia. Odśwież stronę za chwilę albo zadzwoń — ${PHONES}.`,
        true,
      );
      return;
    }
    if (!data || !data.ok) {
      hideGuest();
      storage.set(NAME_KEY, null);
      showStatus(
        `Ten link nie jest aktywny. Sprawdź, czy został skopiowany w całości, albo zadzwoń — ${PHONES}.`,
        true,
      );
      return;
    }

    invite = data;
    showGuest(data.displayName, true);
    storage.set(NAME_KEY, data.displayName);

    if (data.response) {
      buildForm();
      prefill(data.response);
      syncVisibility();
      showSummary();
      return;
    }
    if (isLocked()) {
      showStatus(
        `Termin potwierdzeń minął 30 czerwca 2027. Prosimy o kontakt telefoniczny — ${PHONES}.`,
      );
      return;
    }
    buildForm();
    syncVisibility();
    statusEl.hidden = true;
    form.hidden = false;
  }

  // Pokazuje stronę, gdy fonty są wczytane (bez mignięcia fontów); nazwa gościa dochodzi osobno
  function reveal() {
    const fontsReady = document.fonts
      ? document.fonts.ready
      : Promise.resolve();
    fontsReady.then(() =>
      document.documentElement.classList.remove("is-loading"),
    );
  }

  form.addEventListener("submit", onSubmit);
  // synchroniczny początek init() chowa/wstawia nazwę jeszcze przed reveal()
  init().finally(() => {
    $("#rsvp-loader").hidden = true;
  });
  reveal();
})();

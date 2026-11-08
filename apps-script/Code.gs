/**
 * Backend RSVP — Ania & Łukasz, 19.08.2027
 *
 * Wklej ten plik w: Arkusz Google → Rozszerzenia → Apps Script.
 * Instrukcja krok po kroku: README.md w repozytorium.
 *
 * @OnlyCurrentDoc  (skrypt ma dostęp wyłącznie do tego jednego arkusza)
 */

const CONFIG = {
  // Adres strony na GitHub Pages (z ukośnikiem na końcu) — z niego powstają linki i kody QR.
  BASE_URL: 'https://TWOJ-LOGIN.github.io/zaproszenie/',
  // Kto dostaje maila po każdej odpowiedzi. Uzupełnij TYLKO w edytorze Apps Script, nie w repozytorium.
  NOTIFY_EMAILS: ['TWOJ-EMAIL@gmail.com', 'EMAIL-ANI@gmail.com'],
  // Ostatni moment na potwierdzenie / zmianę (musi zgadzać się z config.js).
  DEADLINE: new Date('2027-06-30T23:59:59+02:00'),
  GUESTS_SHEET: 'Goście',
  RESPONSES_SHEET: 'Odpowiedzi',
  PEOPLE_SHEET: 'Osoby',
  SUMMARY_SHEET: 'Podsumowanie',
  MAX_EDITS: 30,
  MAX_CHILDREN: 6,
};

// Zmieniaj przy każdej zmianie kodu: odpowiedź backendu to pokazuje, więc widać, czy wdrożona jest nowa wersja.
const BACKEND_VERSION = '2026-11-08 telefon';

const GUEST_HEADERS = ['token', 'nazwa', 'osoby', 'nocleg', 'osoba_tow', 'dzieci', 'link', 'qr', 'notatki'];
// Odpowiedzi: jeden wiersz na zaproszenie (same liczby + json do edycji). Osoby: jeden wiersz na człowieka.
const RESPONSE_HEADERS = [
  'token', 'zaproszenie', 'telefon', 'utworzono', 'zmieniono', 'edycje', 'przychodzi', 'nie_przychodzi', 'dorosli',
  'dzieci', 'nocleg', 'komentarz', 'json',
];
// Kolejność ma znaczenie dla formuł w „Podsumowaniu” (E = obecny, D = typ, F = dieta, I = nocleg)
const PEOPLE_HEADERS = ['token', 'zaproszenie', 'osoba', 'typ', 'obecny', 'dieta', 'alergie', 'wiek', 'nocleg'];

const DIETS = {
  standard: 'standardowa',
  vegetarian: 'wegetariańska',
  vegan: 'wegańska',
  gluten_free: 'bezglutenowa',
  other: 'inna',
};

// "+1" w kolumnie "osoby" = osoba towarzysząca, która sama wpisuje imię i nazwisko
const isPlusSlot = (name) => /^\+\s*1$/.test(String(name).trim());

const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 znaki, bez l/o/0/1
const TOKEN_LENGTH = 10;

// ======================= API =======================

function doGet(e) {
  try {
    const guest = findGuest(e && e.parameter && e.parameter.t);
    if (!guest) return json({ ok: false, error: 'invalid' });
    const resp = findResponse(guest.token);
    return json({
      ok: true,
      displayName: guest.displayName,
      guests: guest.people,
      flags: guest.flags,
      response: resp ? resp.data : null,
      updatedAt: resp ? resp.updatedAt : null,
      locked: isLocked(),
    });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: 'server' });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return json({ ok: false, error: 'busy' });
  try {
    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (_) {
      return json({ ok: false, error: 'bad_request' });
    }
    const guest = findGuest(body && body.token);
    if (!guest) return json({ ok: false, error: 'invalid' });
    if (isLocked()) return json({ ok: false, error: 'locked' });

    const data = sanitize(body, guest);
    const existing = findResponse(guest.token);
    if (existing && existing.edits >= CONFIG.MAX_EDITS) return json({ ok: false, error: 'too_many_edits' });

    const now = new Date();
    const record = toRecord(guest, data, existing ? existing.createdAt : now, now, existing ? existing.edits + 1 : 0);
    const sheet = ensureSheet(CONFIG.RESPONSES_SHEET, RESPONSE_HEADERS);
    const row = rowFor(sheet, record);
    if (existing) sheet.getRange(existing.row, 1, 1, row.length).setValues([row]);
    else sheet.appendRow(row);
    writePeople(guest.token, toPeople(guest, data));

    notify(guest, data, Boolean(existing));
    return json({ ok: true, updatedAt: now.toISOString() });
  } catch (err) {
    if (err && err.validation) return json({ ok: false, error: 'invalid_data', field: err.message });
    console.error(err);
    return json({ ok: false, error: 'server' });
  } finally {
    lock.releaseLock();
  }
}

// ======================= Walidacja =======================

function validationError(field) {
  const err = new Error(field);
  err.validation = true;
  return err;
}

/** Buduje odpowiedź wyłącznie z pól dozwolonych dla danego zaproszenia. Imiona zawsze z arkusza, nie z przeglądarki. */
function sanitize(body, guest) {
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const diet = (v) => (Object.prototype.hasOwnProperty.call(DIETS, v) ? v : 'standard');

  if (!Array.isArray(body.guests) || body.guests.length !== guest.people.length) throw validationError('guests');
  const guests = guest.people.map((name, i) => {
    const g = body.guests[i] || {};
    if (typeof g.attending !== 'boolean') throw validationError('attending');
    if (!g.attending) return { name, attending: false };
    const out = { name, attending: true, diet: diet(g.diet), allergies: str(g.allergies, 300) };
    if (isPlusSlot(name)) {
      out.fullName = str(g.fullName, 100);
      if (!out.fullName) throw validationError('plusName');
    }
    return out;
  });
  const any = guests.some((g) => g.attending);
  const out = { guests, plusOne: null, children: null, accommodation: null, comment: str(body.comment, 1000) };
  if (!any) return out;

  out.phone = str(body.phone, 20);
  if (!/^\+?[0-9][0-9 ()\-]{6,18}$/.test(out.phone) || out.phone.replace(/\D/g, '').length < 7) throw validationError('phone');

  if (guest.flags.plusOne) {
    const p = body.plusOne || {};
    if (p.coming === true) {
      const name = str(p.name, 100);
      if (!name) throw validationError('plusOne');
      out.plusOne = { coming: true, name, diet: diet(p.diet), allergies: str(p.allergies, 300) };
    } else {
      out.plusOne = { coming: false };
    }
  }

  if (guest.flags.children) {
    const list = (body.children && body.children.list) || [];
    if (!Array.isArray(list) || list.length > CONFIG.MAX_CHILDREN) throw validationError('children');
    const kids = list.map((k) => ({ name: str(k && k.name, 100), age: Number(k && k.age) }));
    if (kids.some((k) => !k.name || !Number.isInteger(k.age) || k.age < 0 || k.age > 17)) throw validationError('children');
    out.children = { count: kids.length, list: kids };
  }

  if (guest.flags.accommodation) {
    if (typeof body.accommodation !== 'boolean') throw validationError('accommodation');
    out.accommodation = body.accommodation;
  }
  return out;
}

// ======================= Arkusze =======================

function guestsSheet() { return SpreadsheetApp.getActive().getSheetByName(CONFIG.GUESTS_SHEET); }
function responsesSheet() { return SpreadsheetApp.getActive().getSheetByName(CONFIG.RESPONSES_SHEET); }

/** Arkusz o tej nazwie; jeśli go nie ma, tworzy go z nagłówkami. Brakujące nagłówki (nowe kolumny) dopisuje na końcu. */
function ensureSheet(name, headers) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }
  const have = headerIndex(sh);
  const missing = headers.filter((h) => !(h in have));
  if (missing.length) sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  return sh;
}

/** Wiersz ułożony według nagłówków w arkuszu: dodane, usunięte czy przestawione kolumny niczego nie rozjadą. */
function rowFor(sheet, record) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h).trim().toLowerCase());
  return headers.map((h) => (h in record ? record[h] : ''));
}

/** Podmienia wiersze danego zaproszenia w „Osobach” — w tym samym miejscu, jeśli już tam były. */
function writePeople(token, people) {
  const sheet = ensureSheet(CONFIG.PEOPLE_SHEET, PEOPLE_HEADERS);
  const tokenCol = headerIndex(sheet).token;
  let at = 0;
  if (sheet.getLastRow() >= 2 && tokenCol !== undefined) {
    const tokens = sheet.getRange(2, tokenCol + 1, sheet.getLastRow() - 1, 1).getValues();
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (normToken(tokens[i][0]) !== token) continue;
      sheet.deleteRow(i + 2);
      at = i + 2; // od dołu, więc na końcu zostaje pierwszy (najwyższy) wiersz
    }
  }
  const rows = people.map((p) => rowFor(sheet, p));
  if (at && at <= sheet.getLastRow()) {
    sheet.insertRowsBefore(at, rows.length);
    sheet.getRange(at, 1, rows.length, rows[0].length).setValues(rows);
  } else {
    rows.forEach((r) => sheet.appendRow(r));
  }
}

function headerIndex(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = {};
  headers.forEach((h, i) => { idx[String(h).trim().toLowerCase()] = i; });
  return idx;
}

function normToken(t) {
  const s = String(t == null ? '' : t).trim().toLowerCase();
  return /^[a-z0-9]{6,32}$/.test(s) ? s : '';
}

const truthy = (v) => v === true || /^(tak|true|x|1|yes)$/i.test(String(v).trim());

function findGuest(rawToken) {
  const token = normToken(rawToken);
  return token ? loadGuests()[token] || null : null;
}

// Lista gości w pamięci podręcznej skryptu (czytanie arkusza to najwolniejsza część zapytania).
// Czyścimy ją przy każdej ręcznej edycji arkusza (onEdit) i po generowaniu linków.
const GUESTS_CACHE_KEY = 'guests';
const GUESTS_CACHE_SECONDS = 600;

function loadGuests() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(GUESTS_CACHE_KEY);
  if (hit) return JSON.parse(hit);

  const guests = {};
  const sheet = guestsSheet();
  if (sheet && sheet.getLastRow() >= 2) {
    const col = headerIndex(sheet);
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    rows.forEach((r) => {
      const token = normToken(r[col.token]);
      const people = String(r[col.osoby]).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
      const displayName = String(r[col.nazwa]).trim();
      if (!token || !people.length || !displayName) return;
      guests[token] = {
        token,
        displayName,
        people,
        flags: { accommodation: truthy(r[col.nocleg]), plusOne: truthy(r[col.osoba_tow]), children: truthy(r[col.dzieci]) },
      };
    });
  }
  const json = JSON.stringify(guests);
  if (json.length < 90000) cache.put(GUESTS_CACHE_KEY, json, GUESTS_CACHE_SECONDS); // limit wpisu w cache: 100 KB
  return guests;
}

function clearGuestsCache() {
  CacheService.getScriptCache().remove(GUESTS_CACHE_KEY);
}

/** Prosty wyzwalacz: każda ręczna zmiana w arkuszu (np. nazwa, osoby, pola wyboru) od razu trafia na stronę. */
function onEdit() {
  clearGuestsCache();
}

function findResponse(token) {
  const sheet = responsesSheet();
  if (!sheet || sheet.getLastRow() < 2) return null;
  const col = headerIndex(sheet);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][col.token]).trim().toLowerCase() !== token) continue;
    let data = null;
    try { data = JSON.parse(rows[i][col.json]); } catch (_) { /* uszkodzony wiersz — traktujemy jak brak danych */ }
    const updated = rows[i][col.zmieniono];
    return {
      row: i + 2,
      data,
      createdAt: rows[i][col.utworzono],
      updatedAt: updated instanceof Date ? updated.toISOString() : null,
      edits: Number(rows[i][col.edycje]) || 0,
    };
  }
  return null;
}

/** Zapobiega wstrzykiwaniu formuł: tekst zaczynający się od = + - @ zapisujemy jako zwykły tekst. */
function cell(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

const yesNo = (v) => (v === null || v === undefined ? '' : v ? 'tak' : 'nie');

/** Każda osoba z odpowiedzi osobno: goście z imienia, osoby towarzyszące, dzieci (klucze = PEOPLE_HEADERS). */
function toPeople(guest, d) {
  const base = { token: guest.token, zaproszenie: cell(guest.displayName), nocleg: yesNo(d.accommodation) };
  const person = (osoba, typ, g) => ({
    ...base,
    osoba: cell(osoba),
    typ,
    obecny: yesNo(g.attending),
    dieta: g.attending ? DIETS[g.diet] : '',
    alergie: g.attending ? cell(g.allergies) : '',
  });
  const people = d.guests.map((g) =>
    isPlusSlot(g.name)
      ? person(g.attending ? g.fullName : 'osoba towarzysząca', 'osoba towarzysząca', g)
      : person(g.name, 'gość', g),
  );
  if (d.plusOne) {
    const p = d.plusOne;
    people.push(person(p.coming ? p.name : 'osoba towarzysząca', 'osoba towarzysząca', { ...p, attending: p.coming }));
  }
  if (d.children) {
    d.children.list.forEach((k) => people.push({ ...base, osoba: cell(k.name), typ: 'dziecko', obecny: 'tak', wiek: k.age }));
  }
  return people;
}

/** Jedna odpowiedź jako { nagłówek kolumny: wartość } (klucze = RESPONSE_HEADERS). */
function toRecord(guest, d, createdAt, updatedAt, edits) {
  const people = toPeople(guest, d);
  const coming = people.filter((p) => p.obecny === 'tak');
  const kids = coming.filter((p) => p.typ === 'dziecko').length;
  return {
    token: guest.token,
    zaproszenie: cell(guest.displayName),
    telefon: cell(d.phone),
    utworzono: createdAt,
    zmieniono: updatedAt,
    edycje: edits,
    przychodzi: coming.length,
    nie_przychodzi: people.length - coming.length,
    dorosli: coming.length - kids,
    dzieci: kids,
    nocleg: yesNo(d.accommodation),
    komentarz: cell(d.comment),
    json: JSON.stringify(d),
  };
}

// ======================= Mail =======================

function notify(guest, d, isUpdate) {
  const to = CONFIG.NOTIFY_EMAILS.filter((m) => /@/.test(m) && !/TWOJ-EMAIL|EMAIL-ANI/.test(m));
  if (!to.length) return;
  const r = toRecord(guest, d, '', '', 0);
  const people = toPeople(guest, d);
  const label = (p) => p.osoba + (p.typ === 'gość' ? '' : p.typ === 'dziecko' ? ` (dziecko, ${p.wiek} l.)` : ` (${p.typ})`);
  const coming = people.filter((p) => p.obecny === 'tak');
  const notComing = people.filter((p) => p.obecny !== 'tak');
  const lines = [`${guest.displayName} — ${isUpdate ? 'ZMIANA odpowiedzi' : 'nowe potwierdzenie'}`, ''];
  lines.push(`Przychodzą (${coming.length}):`);
  coming.forEach((p) => lines.push(`  • ${label(p)}${p.dieta ? ' — ' + p.dieta : ''}${p.alergie ? ', alergie: ' + p.alergie : ''}`));
  if (!coming.length) lines.push('  —');
  if (notComing.length) lines.push('', `Nie przychodzą: ${notComing.map(label).join(', ')}`);
  const extra = [];
  if (d.phone) extra.push(`Telefon: ${d.phone}`);
  if (d.accommodation !== null) extra.push(`Nocleg: ${r.nocleg}`);
  if (extra.length) lines.push('', ...extra);
  if (d.comment) lines.push('', `Wiadomość: ${d.comment}`);
  lines.push('', SpreadsheetApp.getActive().getUrl());
  try {
    MailApp.sendEmail({
      to: to.join(','),
      subject: `[Wesele] ${guest.displayName} — ${isUpdate ? 'zmiana' : 'RSVP'} (${r.przychodzi} os.)`,
      body: lines.join('\n'),
    });
  } catch (err) {
    console.error('Mail nie został wysłany', err); // odpowiedź i tak jest zapisana
  }
}

// ======================= Menu w arkuszu =======================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Zaproszenia')
    .addItem('1. Przygotuj arkusze', 'setupSheets')
    .addItem('2. Generuj tokeny, linki i QR', 'generateLinks')
    .addToUi();
}

function setupSheets() {
  const guests = ensureSheet(CONFIG.GUESTS_SHEET, GUEST_HEADERS);
  ensureSheet(CONFIG.RESPONSES_SHEET, RESPONSE_HEADERS);
  ensureSheet(CONFIG.PEOPLE_SHEET, PEOPLE_HEADERS);
  setupSummary();
  const col = headerIndex(guests);
  ['nocleg', 'osoba_tow', 'dzieci'].forEach((h) => guests.getRange(2, col[h] + 1, 300, 1).insertCheckboxes());
  if (guests.getLastRow() < 2) {
    guests.getRange(2, col.nazwa + 1, 1, 2).setValues([['Lucynę i Michała Foberów', 'Lucyna, Michał']]);
  }
  clearGuestsCache();
  SpreadsheetApp.getUi().alert('Gotowe. Uzupełnij arkusz „Goście”: nazwa = forma z zaproszenia (np. „Lucynę i Michała Foberów”), osoby = imiona po przecinku.');
}

/** Arkusz „Podsumowanie”: same formuły liczone z „Osób” (nadpisywany przy każdym „Przygotuj arkusze”). */
function setupSummary() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CONFIG.SUMMARY_SHEET) || ss.insertSheet(CONFIG.SUMMARY_SHEET);
  const o = `'${CONFIG.PEOPLE_SHEET}'`;
  const g = `'${CONFIG.GUESTS_SHEET}'`;
  const r = `'${CONFIG.RESPONSES_SHEET}'`;
  sh.clear();
  sh.getRange(1, 1, 8, 2).setValues([
    ['Przychodzi łącznie', `=COUNTIF(${o}!E2:E, "tak")`],
    ['— dorośli', `=COUNTIFS(${o}!E2:E, "tak", ${o}!D2:D, "<>dziecko")`],
    ['— dzieci', `=COUNTIFS(${o}!E2:E, "tak", ${o}!D2:D, "dziecko")`],
    ['Nie przychodzi', `=COUNTIF(${o}!E2:E, "nie")`],
    ['Osoby z noclegiem', `=COUNTIFS(${o}!E2:E, "tak", ${o}!I2:I, "tak")`],
    ['Zaproszenia z odpowiedzią', `=COUNTA(${r}!A2:A)`],
    ['Zaproszenia bez odpowiedzi', `=COUNTA(${g}!A2:A) - COUNTA(${r}!A2:A)`],
    ['', ''],
  ]);
  sh.getRange('A10').setValue('Diety (osoby obecne)').setFontWeight('bold');
  sh.getRange('A11').setFormula(`=IFERROR(QUERY(${o}!C2:I, "select F, count(C) where E = 'tak' and F <> '' group by F label F 'dieta', count(C) 'osób'", 0), "brak")`);
  sh.getRange('D10').setValue('Alergie / uwagi').setFontWeight('bold');
  sh.getRange('D11').setFormula(`=IFERROR(QUERY(${o}!C2:I, "select C, G where E = 'tak' and G <> ''", 0), "brak")`);
  sh.getRange('A1:A7').setFontWeight('bold');
  sh.autoResizeColumns(1, 5);
}

function generateLinks() {
  const ui = SpreadsheetApp.getUi();
  if (/TWOJ-LOGIN/.test(CONFIG.BASE_URL)) {
    ui.alert('Najpierw ustaw CONFIG.BASE_URL w Code.gs na adres strony z GitHub Pages.');
    return;
  }
  const sheet = guestsSheet();
  const last = sheet.getLastRow();
  if (last < 2) return;
  const col = headerIndex(sheet);
  const n = last - 1;
  const names = sheet.getRange(2, col.nazwa + 1, n, 1).getValues();
  const tokens = sheet.getRange(2, col.token + 1, n, 1).getValues();
  const used = new Set(tokens.map((t) => String(t[0]).trim()).filter(Boolean));
  const links = [];
  const qrs = [];
  let created = 0;
  for (let i = 0; i < n; i++) {
    if (!String(names[i][0]).trim()) {
      links.push([sheet.getRange(i + 2, col.link + 1).getValue()]);
      qrs.push([sheet.getRange(i + 2, col.qr + 1).getFormula()]);
      continue;
    }
    if (!String(tokens[i][0]).trim()) {
      let t;
      do { t = newToken(); } while (used.has(t));
      used.add(t);
      tokens[i][0] = t;
      created++;
    }
    const link = CONFIG.BASE_URL + tokens[i][0]; // …/zaproszenie/TOKEN — przeżywa przekierowania (np. kody QR z Canvy)
    links.push([link]);
    qrs.push([`=IMAGE("https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=16&data=" & ENCODEURL("${link}"))`]);
  }
  sheet.getRange(2, col.token + 1, n, 1).setValues(tokens);
  sheet.getRange(2, col.link + 1, n, 1).setValues(links);
  sheet.getRange(2, col.qr + 1, n, 1).setFormulas(qrs);
  clearGuestsCache();
  ui.alert(`Gotowe. Nowych tokenów: ${created}. Linki i kody QR są w kolumnach „link” i „qr”.`);
}

/** 10 znaków z 32-znakowego alfabetu; losowość z UUID v4 (pomijamy stałe bity wersji i wariantu). */
function newToken() {
  const nibbles = [];
  while (nibbles.length < TOKEN_LENGTH * 2) {
    const hex = Utilities.getUuid().replace(/-/g, '');
    for (let i = 0; i < hex.length; i++) if (i !== 12 && i !== 16) nibbles.push(parseInt(hex[i], 16));
  }
  let out = '';
  for (let i = 0; i < TOKEN_LENGTH; i++) out += TOKEN_ALPHABET[(nibbles[2 * i] * 16 + nibbles[2 * i + 1]) % 32];
  return out;
}

function isLocked() { return Date.now() > CONFIG.DEADLINE.getTime(); }

function json(obj) {
  const body = Object.assign({}, obj, { version: BACKEND_VERSION });
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

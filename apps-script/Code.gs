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
  MAX_EDITS: 30,
  MAX_CHILDREN: 6,
};

const GUEST_HEADERS = ['token', 'nazwa', 'osoby', 'nocleg', 'osoba_tow', 'dzieci', 'link', 'qr', 'notatki'];
const RESPONSE_HEADERS = [
  'token', 'nazwa', 'utworzono', 'zmieniono', 'edycje', 'osoby_razem', 'obecni', 'nieobecni', 'diety',
  'os_tow', 'os_tow_dieta', 'dzieci_liczba', 'dzieci_wiek', 'transport', 'nocleg', 'komentarz', 'json',
];

const DIETS = {
  standard: 'standardowa',
  vegetarian: 'wegetariańska',
  vegan: 'wegańska',
  gluten_free: 'bezglutenowa',
  other: 'inna',
};

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
    const row = toRow(guest, data, existing ? existing.createdAt : now, now, existing ? existing.edits + 1 : 0);
    const sheet = responsesSheet();
    if (existing) sheet.getRange(existing.row, 1, 1, row.length).setValues([row]);
    else sheet.appendRow(row);

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
    return g.attending
      ? { name, attending: true, diet: diet(g.diet), allergies: str(g.allergies, 300) }
      : { name, attending: false };
  });
  const any = guests.some((g) => g.attending);
  const out = { guests, plusOne: null, children: null, transport: null, accommodation: null, comment: str(body.comment, 1000) };
  if (!any) return out;

  if (body.transport !== 'own' && body.transport !== 'need') throw validationError('transport');
  out.transport = body.transport;

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
    const c = body.children || {};
    const count = Number(c.count);
    if (!Number.isInteger(count) || count < 0 || count > CONFIG.MAX_CHILDREN) throw validationError('children');
    const ages = Array.isArray(c.ages) ? c.ages.slice(0, count).map(Number) : [];
    if (ages.length !== count || ages.some((a) => !Number.isInteger(a) || a < 0 || a > 17)) throw validationError('children');
    out.children = { count, ages };
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
  if (!token) return null;
  const sheet = guestsSheet();
  if (!sheet || sheet.getLastRow() < 2) return null;
  const col = headerIndex(sheet);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const r = rows.find((row) => String(row[col.token]).trim().toLowerCase() === token);
  if (!r) return null;
  const people = String(r[col.osoby]).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  const displayName = String(r[col.nazwa]).trim();
  if (!people.length || !displayName) return null;
  return {
    token,
    displayName,
    people,
    flags: { accommodation: truthy(r[col.nocleg]), plusOne: truthy(r[col.osoba_tow]), children: truthy(r[col.dzieci]) },
  };
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

function toRow(guest, d, createdAt, updatedAt, edits) {
  const coming = d.guests.filter((g) => g.attending);
  const headcount = coming.length + (d.plusOne && d.plusOne.coming ? 1 : 0) + (d.children ? d.children.count : 0);
  const dietText = (g) => DIETS[g.diet] + (g.allergies ? ` (${g.allergies})` : '');
  return [
    guest.token,
    cell(guest.displayName),
    createdAt,
    updatedAt,
    edits,
    headcount,
    cell(coming.map((g) => g.name).join(', ')),
    cell(d.guests.filter((g) => !g.attending).map((g) => g.name).join(', ')),
    cell(coming.map((g) => `${g.name}: ${dietText(g)}`).join('; ')),
    cell(d.plusOne ? (d.plusOne.coming ? d.plusOne.name : 'nie') : ''),
    cell(d.plusOne && d.plusOne.coming ? dietText(d.plusOne) : ''),
    d.children ? d.children.count : '',
    d.children ? d.children.ages.join(', ') : '',
    d.transport === 'need' ? 'potrzebny' : d.transport === 'own' ? 'własny' : '',
    d.accommodation === null ? '' : d.accommodation ? 'tak' : 'nie',
    cell(d.comment),
    JSON.stringify(d),
  ];
}

// ======================= Mail =======================

function notify(guest, d, isUpdate) {
  const to = CONFIG.NOTIFY_EMAILS.filter((m) => /@/.test(m) && !/TWOJ-EMAIL|EMAIL-ANI/.test(m));
  if (!to.length) return;
  const row = toRow(guest, d, '', '', 0);
  const lines = [
    `${guest.displayName} — ${isUpdate ? 'ZMIANA odpowiedzi' : 'nowe potwierdzenie'}`,
    '',
    `Przychodzą: ${row[6] || '—'}`,
    `Nie przychodzą: ${row[7] || '—'}`,
    `Diety: ${row[8] || '—'}`,
  ];
  if (d.plusOne) lines.push(`Osoba towarzysząca: ${row[9]}${row[10] ? ' — ' + row[10] : ''}`);
  if (d.children) lines.push(`Dzieci: ${d.children.count}${d.children.count ? ' (wiek: ' + row[12] + ')' : ''}`);
  if (d.transport) lines.push(`Transport: ${row[13]}`);
  if (d.accommodation !== null) lines.push(`Nocleg: ${row[14]}`);
  if (d.comment) lines.push('', `Wiadomość: ${d.comment}`);
  lines.push('', `Razem osób: ${row[5]}`, '', SpreadsheetApp.getActive().getUrl());
  try {
    MailApp.sendEmail({
      to: to.join(','),
      subject: `[Wesele] ${guest.displayName} — ${isUpdate ? 'zmiana' : 'RSVP'} (${row[5]} os.)`,
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
  const ss = SpreadsheetApp.getActive();
  const make = (name, headers) => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  };
  const guests = make(CONFIG.GUESTS_SHEET, GUEST_HEADERS);
  make(CONFIG.RESPONSES_SHEET, RESPONSE_HEADERS);
  const col = headerIndex(guests);
  ['nocleg', 'osoba_tow', 'dzieci'].forEach((h) => guests.getRange(2, col[h] + 1, 300, 1).insertCheckboxes());
  if (guests.getLastRow() < 2) {
    guests.getRange(2, col.nazwa + 1, 1, 2).setValues([['Lucynę i Michała Foberów', 'Lucyna, Michał']]);
  }
  SpreadsheetApp.getUi().alert('Gotowe. Uzupełnij arkusz „Goście”: nazwa = forma z zaproszenia (np. „Lucynę i Michała Foberów”), osoby = imiona po przecinku.');
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
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

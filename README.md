# Zaproszenie + RSVP — Ania & Łukasz, 19.08.2027

Jednostronicowa strona z zaproszeniem (odwzorowanie kartki) i formularzem potwierdzenia.
Odpowiedzi trafiają do Arkusza Google, a Wy dostajecie maila po każdym potwierdzeniu lub zmianie.

```
index.html, styles.css, app.js   strona (GitHub Pages)
config.js                        adres backendu + termin
assets/                          kwiaty, favicon, obrazek podglądu linku (og.png)
apps-script/Code.gs              backend: wklejany do Arkusza Google
```

## Jak to działa

- Każde zaproszenie ma **osobisty token** w linku: `…/zaproszenie/k7f3qx9a2m` (działa też `…/zaproszenie/?t=k7f3qx9a2m`). Forma bez `?` przechodzi przez przekierowania, np. kody QR z Canvy; zamienia ją na właściwy adres plik `404.html`.
- Strona pyta backend o token i dostaje: nazwę z zaproszenia („Lucynę i Michała Foberów”), imiona osób i flagi (nocleg / osoba towarzysząca / dzieci). **Nic z tego nie pochodzi z linku**, więc nie da się podmienić nazwisk.
- Pytania o nocleg, osobę towarzyszącą i dzieci widzą tylko goście z zaznaczoną flagą.
- Po wysłaniu odpowiedź jest zapisywana pod tokenem. Ponowne wejście pokazuje zapisaną odpowiedź i pozwala ją zmienić do **30.06.2027**; potem formularz się blokuje (sprawdzane też po stronie serwera).
- Bez tokenu (lub ze złym) strona pokazuje zaproszenie bez formularza i prosi o osobisty link albo telefon.

## 1. Arkusz i backend (Apps Script)

1. Utwórz nowy Arkusz Google (np. „Wesele — RSVP”).
2. **Rozszerzenia → Apps Script**. Usuń przykładowy kod i wklej całość `apps-script/Code.gs`.
3. Uzupełnij `CONFIG` na górze pliku **w edytorze Apps Script** (nie w repozytorium, bo repo jest publiczne):
   - `NOTIFY_EMAILS`: Twój mail i mail Ani,
   - `BASE_URL`: ustawisz po kroku 3 (adres GitHub Pages).
4. Zapisz (💾), wróć do arkusza i odśwież stronę. Pojawi się menu **Zaproszenia**.
5. **Zaproszenia → 1. Przygotuj arkusze**. Google poprosi o uprawnienia: zobaczysz ostrzeżenie „Google nie zweryfikował tej aplikacji”. To normalne dla własnego skryptu: **Zaawansowane → Przejdź do projektu**. Skrypt ma dostęp tylko do tego arkusza (`@OnlyCurrentDoc`) i do wysyłania maili.

## 2. Wdrożenie backendu

1. W Apps Script: **Wdróż → Nowe wdrożenie → typ: Aplikacja internetowa**.
   - Wykonaj jako: **Ja**
   - Kto ma dostęp: **Każdy**
2. Skopiuj adres kończący się na `/exec` i wklej go do `config.js` jako `scriptUrl`.

„Każdy” oznacza, że każdy może *wywołać* ten adres, ale skrypt robi tylko dwie rzeczy: zwraca dane jednego zaproszenia dla poprawnego tokenu i zapisuje odpowiedź dla poprawnego tokenu. Arkusza nikt poza Wami nie widzi.

**Po każdej zmianie w Code.gs**: Wdróż → Zarządzaj wdrożeniami → ✏️ → Wersja: *Nowa wersja* → Wdróż. Adres `/exec` się nie zmienia.

## 3. Strona na GitHub Pages

```bash
cd ~/Desktop/projects/zaproszenie
git init && git add . && git commit -m "Zaproszenie"
gh repo create zaproszenie --public --source . --push
```

Potem na GitHubie: **Settings → Pages → Deploy from a branch → main / (root)**.
Strona będzie pod `https://TWOJ-LOGIN.github.io/zaproszenie/`. Ten adres wpisz:
- w `Code.gs` → `CONFIG.BASE_URL` (i wdróż nową wersję),
- w `index.html` → `og:image` (podgląd linku w Messengerze/WhatsAppie).

## 4. Lista gości, linki i kody QR

W arkuszu **Goście** jeden wiersz = jedno zaproszenie:

| kolumna | co wpisać |
|---|---|
| `nazwa` | dokładnie jak na zaproszeniu, w bierniku: *Lucynę i Michała Foberów* |
| `osoby` | imiona po przecinku: *Lucyna, Michał* (każda osoba potwierdza osobno). Wpisz `+1` jako osobę (np. *Lubomir Jachowicz, +1*), żeby osoba towarzysząca sama podała imię i nazwisko |
| `nocleg` / `osoba_tow` / `dzieci` | zaznacz, jeśli to zaproszenie ma widzieć to pytanie |
| `notatki` | dla Was, strona tego nie czyta |

Potem **Zaproszenia → 2. Generuj tokeny, linki i QR**. Uzupełnia brakujące tokeny (istniejących nie zmienia), kolumnę `link` (do wysłania SMS-em/Messengerem) i `qr` (do druku).
Kod QR do pliku: otwórz w przeglądarce adres z formuły w kolumnie `qr` i zapisz obrazek.
Kody QR generuje zewnętrzny serwis api.qrserver.com, który widzi więc same linki (bez nazwisk).

> Nie zmieniajcie tokenu po wysłaniu zaproszenia, bo stary link przestanie działać.

## 5. Odpowiedzi

Arkusz **Odpowiedzi**: jeden wiersz na zaproszenie (zmiana nadpisuje wiersz, licznik w `edycje`).
`osoby_razem` = obecni + osoba towarzysząca + dzieci, więc łączna liczba gości to `=SUM(Odpowiedzi!F:F)`.

## Testowanie lokalnie

```bash
python3 -m http.server 8137 --bind 127.0.0.1
```

Tryb demo działa tylko na localhost, bez backendu:
- http://localhost:8137/?t=demo: para, nocleg + dzieci
- http://localhost:8137/?t=demo-solo: jedna osoba + osoba towarzysząca
- http://localhost:8137/?t=demo-plain: para, bez dodatkowych pytań
- http://localhost:8137/?t=demo-locked: po terminie, z zapisaną odpowiedzią
- http://localhost:8137/: brak tokenu

Test backendu: dodaj w arkuszu wiersz testowy, wygeneruj link, wyślij formularz, sprawdź wiersz w „Odpowiedziach” i maila, wyślij ponownie (wiersz ma się zaktualizować, a nie zdublować). Potem usuń wiersze testowe.

## Bezpieczeństwo w skrócie

- Token: 10 znaków z 32-znakowego alfabetu (~10¹⁵ kombinacji), nie do zgadnięcia.
- Serwer przyjmuje tylko pola dozwolone dla danego zaproszenia, imiona bierze z arkusza, pilnuje terminu i limitów długości.
- Tekst zaczynający się od `= + - @` jest zapisywany jako zwykły tekst (bez formuł). Maile są wysyłane jako zwykły tekst.
- Strona ma `noindex`, więc nie pojawi się w Google.
- Najgorszy przypadek: ktoś przekaże swój link dalej. Wtedy osoba z linkiem widzi imiona z tego jednego zaproszenia i może zmienić jego odpowiedź, a Wy dostajecie maila o każdej zmianie.

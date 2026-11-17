# Гид к защите Final (только для команды, в отчёт не входит)

## 1. Как работает система — одним абзацем

Посетитель открывает сайт (или сканирует QR-код на двери, тогда в ссылке уже есть зал и код двери).
Браузер (`public/app.js`) раз в 30 секунд делает `GET /api/gyms`, сервер (`server.js`) считает
открытые визиты в базе (`lib/db.js` → таблица `checkin`, где `check_out_at IS NULL`) и возвращает
число людей и уровень Low/Medium/High (% от вместимости: <35 Low, <75 Medium). Check-in —
`POST /api/checkin` → проверки → `INSERT` строки в `checkin`. Check-out — `POST /api/checkout` →
`UPDATE ... SET check_out_at`. Каждую минуту и перед каждым чтением сервер закрывает визиты старше
3 часов (R8). Сотрудник входит на `/admin`: пароль проверяется через scrypt, сервер выдаёт cookie
сессии, и дальше на каждом защищённом запросе проверяет роль (admin / analyst).

```
Телефон/ноутбук ──HTTP(S)──► server.js ──► lib/db.js ──► gym_crowd_tracker.sqlite
   index.html/app.js            │  проверка ввода, ролей, QR
   admin.html/admin.js          └─ lib/auth.js (scrypt, сессии), lib/qr.js (QR-картинки)
```

## 2. Где что лежит (запомнить!)

| Хочу найти… | Файл | Функция / место |
|---|---|---|
| Check-in / check-out | `server.js` | `'POST /api/checkin'`, `'POST /api/checkout'` |
| Все SQL-запросы | `lib/db.js` | объект `q` |
| Уровень Low/Medium/High | `lib/db.js` | `crowdLevel()` |
| Авто-выход через 3 часа | `lib/db.js` | `q.autoCheckout`; вызов в `server.js` `runAutoCheckout` |
| Пароли, сессии, лимит попыток | `lib/auth.js` | `hashPassword`, `verifyPassword`, `createSession`, `makeRateLimiter` |
| Проверка ролей (401/403) | `server.js` | `requireRole()` |
| Заголовки безопасности (CSP…) | `server.js` | `securityHeaders()` |
| Таблицы и ограничения | `db/schema.sql` | |
| Тестовые данные | `scripts/setup.js` | |
| Интерфейс посетителя | `public/index.html`, `public/app.js` | `checkIn()`, `refresh()`, `say()`, `beep()` |
| Панель сотрудника | `public/admin.html`, `public/admin.js` | `loadDashboard()`, `bars()` |
| QR-коды | `lib/qr.js` (картинка), `server.js` `checkQr()` (проверка) | |
| Датчики (симуляция) | `server.js` `'POST /api/sensor/simulate'`, `scripts/simulate.js` | |
| Тесты | `tests/api.test.js` | 14 тестов |

## 3. Кто за что отвечает (и кто что коммитит)

| Участник | Файлы (коммитит сам со своего GitHub-аккаунта) |
|---|---|
| **Shokayev Daulet** | `server.js` (check-in/out, безопасность, заголовки), `lib/auth.js`, `lib/log.js`, `public/audio/chime.mp3`, звук и text twin в `app.js`, `render.yaml`, раздел README про запуск/хостинг |
| **Taubay Nurkanat** | `public/index.html`, `public/style.css`, `public/app.js` (экран посетителя, 360 px, доступность), `public/img/logo.svg`, `docs/External_Usability_Test_Form.md` + проведение теста |
| **Irbayev Islamnur** | `db/schema.sql`, `lib/db.js`, `scripts/setup.js`, `analysis/analysis_queries.sql`, `public/admin.html`, `public/admin.js`, `scripts/simulate.js`, `lib/qr.js`, `tests/api.test.js` |

Порядок, чтобы всё запускалось: 1) Islamnur — `db/`, `lib/db.js`, `scripts/setup.js`;
2) Daulet — `lib/auth.js`, `lib/log.js`, `server.js`, `package.json`; 3) Nurkanat — `public/` экран посетителя;
4) Islamnur — `public/admin.*`, `lib/qr.js`, `analysis/`, `tests/`; 5) Daulet — `README.md`, `render.yaml`.
**Перед коммитом каждый открывает свои файлы и разбирается в них** — на защите попросят показать
свой коммит и объяснить код построчно.

```bash
git clone https://github.com/<team>/gym-crowd-tracker.git
cd gym-crowd-tracker
# скопировать свои файлы в папку, затем:
git add server.js lib/auth.js lib/log.js
git commit -m "Check-in/out API, scrypt sign-in, sessions, security headers"
git push
```

## 4. Тренировка живых изменений (преподаватель может попросить)

### 4.1 «Добавь поле в форму и сохрани в базу» — цель визита (weights / cardio / class)
1. **База** — `db/schema.sql`, в `CREATE TABLE checkin` добавить строку:
   `purpose TEXT CHECK (purpose IN ('weights', 'cardio', 'class')),`
   Затем `npm run setup` (пересоздаст базу). *Без пересоздания:* в DB Browser выполнить
   `ALTER TABLE checkin ADD COLUMN purpose TEXT;`
2. **SQL** — `lib/db.js`, `insertCheckin`:
   ```js
   INSERT INTO checkin (visitor_id, gym_id, code_id, check_in_at, method, source, purpose)
   VALUES (?, ?, ?, ?, ?, 'real', ?)
   ```
3. **Сервер** — `server.js`, в `'POST /api/checkin'` после `const gymId = …`:
   ```js
   const purpose = body.purpose || null;
   if (purpose && !['weights', 'cardio', 'class'].includes(purpose)) throw new HttpError(400, 'Unknown purpose.');
   ```
   и в `q.insertCheckin.run(...)` добавить последним аргументом `purpose`.
4. **Форма** — `public/index.html`, перед кнопками:
   ```html
   <label for="purpose">Purpose of visit</label>
   <select id="purpose"><option value="">—</option><option value="weights">Weights</option>
     <option value="cardio">Cardio</option><option value="class">Class</option></select>
   ```
5. **JS** — `public/app.js`, в `checkIn()`: `{ code, gymId: selectedGymId(), qr: usableQr('in'), purpose: $('purpose').value || undefined }`
6. **Проверка:** `npm start` → check-in → в DB Browser:
   `SELECT checkin_id, purpose FROM checkin ORDER BY checkin_id DESC LIMIT 1;`

### 4.2 «Измени правило проверки»
* Формат кода: `server.js`, `CODE_RE = /^V-[A-Z0-9]{4,8}$/` → например `{4,10}`.
* Пороги уровня: `lib/db.js`, `crowdLevel()` → `percent < 30 ? 'Low' : percent < 70 ? …`
* Авто-выход через 2 часа для зала 1: `UPDATE gym SET auto_checkout_hours = 2 WHERE gym_id = 1;`
* Лимит попыток входа: `server.js`, `auth.makeRateLimiter(5)` → `3`.

### 4.3 «Измени запрос»
Q1 только за последние 7 дней — `lib/db.js`, `hourly`:
`WHERE check_out_at IS NOT NULL AND date(check_in_at) >= date('now', '-7 days')`

### 4.4 «Найди коммит»
`git log --oneline --author="Daulet"` или на GitHub: Commits → фильтр по автору.

## 5. Ответы на примерные вопросы из задания

1. **Покажи коммит и проведи по коду.** Открыть свой коммит на GitHub → файл → объяснить
   функцию сверху вниз (что проверяется, какой SQL, какой ответ).
2. **Добавь поле.** См. 4.1 — 6 шагов: схема → SQL → сервер → форма → JS → проверка в базе.
3. **Как работает часть товарища и что будет, если она сломается?** Пример: если упадёт авто-выход (R8),
   забытые визиты не закроются и счётчик будет завышен; защита — он вызывается и по таймеру, и перед
   каждым чтением, плюс администратор видит число авто-выходов. Если упадёт сервер — браузер покажет
   «Could not refresh» и предупреждение об устаревших данных (через 90 секунд).
4. **Какое замечание из Stage 1 не учли?** Честно назвать (например, QR сканируется камерой телефона,
   а не отдельным сканером; уведомления только пока страница открыта — нет push-сервера).
5. **Где физически хранятся данные и почему это важно по закону РК?** В файле
   `gym_crowd_tracker.sqlite` на сервере (ноутбук или хостинг). Закон РК № 94-V требует хранить базы
   с персональными данными граждан РК **на территории Казахстана**. Наш код посетителя — псевдоним,
   но по времени визитов его можно связать с человеком, поэтому для реального запуска нужен хостинг в
   Казахстане (Render — это демо). Плюс согласие (галочка), минимум данных, хранение 30 дней.
6. **Где граница безопасности?** Внутри: сервер, база, логи, панель сотрудника (только после входа,
   по ролям). Снаружи (публично): список залов с числом людей и средние часы — только агрегаты.
   Шифрование: HTTPS при хостинге (TLS от Render), локально — HTTP только на 127.0.0.1.
7. **Самое трудное требование?** Например, QR (R1/R2): нужно было генерировать QR без внешних
   библиотек и проверять, что код активный, нужного типа (вход/выход) и нужного зала.
   Чем пожертвовали: push-уведомлениями (R9 работает только при открытой странице).
8. **10 000 пользователей завтра — что упадёт первым?** Опрос раз в 30 с даёт ≈ 330 запросов/с.
   Первым упрётся один процесс Node + SQLite (один писатель) и сессии в памяти. Что делать:
   кэшировать счётчики на 5 с, PostgreSQL вместо SQLite, несколько экземпляров сервера за
   балансировщиком, сессии в Redis, Server-Sent Events вместо опроса.

## 6. Частые вопросы по коду

* **Почему `?` в SQL?** Значение передаётся отдельно от команды → SQL-инъекция невозможна.
* **Зачем уникальный частичный индекс `idx_checkin_open`?** База сама не даст одному коду два открытых визита, даже если два запроса придут одновременно.
* **Почему check-out — UPDATE, а не DELETE?** История нужна для аналитики.
* **Почему `textContent`, а не `innerHTML`?** Чтобы текст не выполнился как HTML/скрипт (XSS).
* **Почему одинаковое сообщение при неверном логине и пароле?** Чтобы не подсказывать, существует ли пользователь.
* **Почему scrypt, а не просто SHA-256?** scrypt специально медленный — перебор паролей очень дорогой; соль делает одинаковые пароли разными хешами.
* **Что такое `timingSafeEqual`?** Сравнение за одинаковое время — нельзя угадать хеш по времени ответа.
* **Зачем HttpOnly / SameSite=Strict?** JS не может прочитать cookie (XSS); чужой сайт не может отправить запрос с нашей cookie (CSRF).
* **Почему без npm-пакетов?** Нечего устанавливать, меньше уязвимостей в зависимостях, проект запускается на защите офлайн.

## 7. Защита Endterm (Project Stage 2): что попросят и что нажать

Перед защитой: `npm run setup` → `npm start` → открыть http://127.0.0.1:3000 и http://127.0.0.1:3000/admin.
Во второй командной строке держать готовым `npm run sql`. Можно также открыть `gym_crowd_tracker.sqlite`
в DB Browser for SQLite (только для чтения, во время демо ничего там не менять).

| Что может попросить преподаватель | Что сделать |
|---|---|
| «Зарегистрируй нового пользователя» | Посетитель: галочка согласия → **Get anonymous code** (новая строка в `visitor`). Сотрудник: /admin → admin / Admin#2026 → блок **Staff accounts** → имя, пароль (≥ 8 символов, буква + цифра), роль → **Register staff member**. Потом выйти и войти под новым аккаунтом. |
| «Покажи, где это значение хранится в базе» | Число людей в зале: `npm run sql -- "SELECT gym_id, COUNT(*) FROM checkin WHERE check_out_at IS NULL GROUP BY gym_id"`. Новый сотрудник: `npm run sql -- "SELECT username, role, password_hash FROM admin_user"` — видно, что пароль хранится только как хеш. Твой визит: `npm run sql -- "SELECT * FROM checkin ORDER BY checkin_id DESC LIMIT 3"`. |
| «Каким запросом построен этот график? Запусти и поменяй группировку» | В панели под каждым графиком **SQL query behind this chart** — это точный текст запроса, который выполнил сервер. Скопировать его в `npm run sql`, потом заменить группировку, например по дню недели: `npm run sql -- "SELECT strftime('%w', check_in_at) AS weekday, COUNT(*) AS visits FROM checkin WHERE check_out_at IS NOT NULL GROUP BY weekday ORDER BY weekday"` (0 = воскресенье). |
| «Открой DevTools» | F12 → **Network** → нажать Check in → видно запрос `POST /api/checkin`, ответ 200 (или 409 при повторе), в Response — JSON. Вкладка **Application → Cookies** на /admin: cookie `sid` с флагами HttpOnly и SameSite=Strict. |
| «Покажи, что безопасность работает» (A3) | Неверный пароль → 401; analyst → **Generate sensor readings** → 403; `password_hash` в базе вместо пароля; SQL-инъекция в поле кода (`V-0001' OR '1'='1`) → «Visitor code must look like V-0001.» |
| «Покажи R3 прямо сейчас» | Visitor View: бейдж «Medium crowd · 47%». Формула в `lib/db.js`, функция `crowdLevel()`: < 35 % Low, < 75 % Medium. |
| «Покажи результат анализа внутри прототипа» (C5) | /admin: графики Q1–Q3 и счётчики — это и есть панель статистики. |
| «Покажи симуляцию датчиков» (D3) | /admin → **Generate sensor readings** или во второй консоли `npm run simulate` (пишет 7 строк каждые 30 с), затем обновить таблицу показаний. |
| «Данные сгенерированы — что можно сказать по графику?» | Что метод работает (запрос, группировка, график), но не как ведут себя реальные посетители: генератор специально добавлял вечерние визиты. |
| «Почему столбчатая, а не линейная?» | Часы и залы — это категории, их сравнивают (bar). Линия — для изменения во времени (например, посещаемость по дням). |

Если ноутбук или сервер подведёт — включить демо-видео, но объяснять и повторять всё равно придётся.

## 8. Новые функции (версия 3) — что это и где в коде

| Функция | Что видит пользователь | Где в коде | Как объяснить |
|---|---|---|---|
| **Темы: светлая / тёмная / авто** | Кнопка-кружок в шапке: авто → светлая → тёмная | `public/theme.js`, переменные цветов в начале `style.css` (`[data-theme="dark"]`) | Все цвета заданы CSS-переменными; тема меняет только значения переменных. «Авто» следует настройке телефона (`prefers-color-scheme`). Выбор хранится в `localStorage`. Скрипт подключён в `<head>`, поэтому страница не мигает белым. |
| **Кольцо загрузки** | Круг вокруг числа людей, цвет по уровню | `index.html` (`<svg class="ring">`), `app.js` → `renderSelectedGym()` | Длина окружности 2·π·54 ≈ 339; закрашенная часть = процент заполненности (`strokeDashoffset`). |
| **Лучшее время сегодня** | «Best time to go today: 14:00» | `app.js` → `loadHours()` | Из обычного профиля по часам берём самый тихий час от текущего до закрытия (23:00). Если у дня недели меньше 20 прошлых визитов — берём профиль за все дни и пишем это на экране. |
| **Сегодня отметилось** | «Today so far: 28 check-ins» | `GET /api/today`, запрос `today` в `lib/db.js` | `COUNT(*)` визитов зала за сегодняшнюю дату, сгруппировано по часу. |
| **Мои визиты** | Число визитов, часы в зале, визиты за 7 дней, любимый зал, последние 5 | `POST /api/my-visits`, запросы `myStats`, `myFavourite`, `myRecent` | Видит только тот, у кого есть код (код — это «ключ»). Имени по-прежнему нет. |
| **Экспорт CSV** | Кнопка «Export CSV» в панели сотрудника | `server.js` → `/api/admin/export.csv`, запрос `exportRows` | Файл для Excel/Google Sheets: все визиты, но **без кодов посетителей** — только внутренний номер. Только admin и analyst (иначе 401). |
| **Постер с QR** | Кнопка «Poster» у каждого QR → печатная табличка для двери | `public/poster.html`, `poster.js`, стили `@media print` | Страница берёт QR через API сотрудника, при печати кнопки скрываются. |
| **Карточки залов** | Нажал на зал внизу → он открылся сверху | `app.js` → `renderGymList()` | `aria-pressed` показывает выбранный зал программам чтения экрана. |

Тестов теперь **16** (`npm test`), тест 16 проверяет новые функции, включая то, что в CSV нет кодов посетителей.

## 9. QR-коды с телефона: `npm run phone`

1. Ноутбук и телефон в одной Wi-Fi сети. Университетский Wi-Fi часто не пускает устройства друг к другу — тогда включи **точку доступа на телефоне** и подключи к ней ноутбук.
2. Вместо `npm start` запусти **`npm run phone`**. В консоли появится строка `Phone (same Wi-Fi): http://192.168.x.x:3000`.
3. Сначала **набери этот адрес в браузере телефона**. Открылось — значит связь есть. Не открылось — это сеть или брандмауэр, не QR.
4. Если Windows спросила про доступ Node.js к сети — **Разрешить** (отметь и частные, и общественные сети). Если окно уже закрыли: Пуск → «Брандмауэр Защитника Windows» → «Разрешить взаимодействие с приложением» → найти **Node.js** → поставить обе галочки.
5. В панели сотрудника над QR-кодами написано, какой адрес внутри кодов. Должен быть `192.168…`, а не `127.0.0.1`. Сканируй камерой — откроется сайт с выбранным залом.

// Запреты движения грузовиков по Европе.
// Самодостаточный модуль по образцу guide.js: ничего не импортирует из app.js
// и не экспортирует наружу, а сам следит за адресной строкой и показывает себя
// на #/bans. В роутер app.js специально НЕ лезем — он про #/bans не знает и
// рисует под нами главную, это штатное поведение (см. CLAUDE.md).
//
// Данные приходят готовыми: их считает робот TRUCK_BANS_EU и складывает в лист
// CALENDAR Google Таблицы, опубликованный как CSV. Здесь никакой логики
// запретов нет — только показ. Так сделано намеренно: правила сложные (вес,
// дни недели, праздники, сезонные окна), и держать их в двух местах нельзя.

// Лист CALENDAR таблицы TRUCK_BANS_EU, отдан как CSV.
// Здесь форма /export, а не /pub, как в FuelInstruction: она отдаёт
// Access-Control-Allow-Origin: * (браузер пускает запрос с нашего домена) и
// всегда показывает живой лист, без отдельного шага «Опубликовать в интернете».
// gid=8091914 — это лист CALENDAR; при пересоздании листа gid поменяется.
const CALENDAR_CSV = 'https://docs.google.com/spreadsheets/d/1VWwlFdhn3wrEUcWoeGOGRK9-Y4gjTU4Xug8z1Sw4fpI/export?format=csv&gid=8091914';

const CACHE_KEY = 'di:bans';       // последний удачный ответ — на случай роуминга
const ROUTE_KEY = 'di:bans:route'; // выбранные водителем страны

const el = {
  root: document.getElementById('bans'),
  close: document.getElementById('bans-close'),
  meta: document.getElementById('bans-meta'),
  tabs: document.getElementById('bans-tabs'),
  body: document.getElementById('bans-body'),
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

let rows = null;        // все строки CSV
let fetchedAt = null;   // когда данные реально скачались
let fromCache = false;
let onlyRoute = false;  // включён фильтр «мой маршрут»
let openCountry = null; // раскрытая карточка страны
let closeTimer = null;

// ---------- CSV ----------

// Свой разбор, а не split(','): в примечаниях есть и запятые, и переводы строк
// внутри кавычек — «наивный» разбор разъезжает по колонкам.
function parseCSV(text) {
  const rowsOut = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rowsOut.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rowsOut.push(row); }

  if (!rowsOut.length) return [];
  const header = rowsOut[0].map((h) => h.trim());
  return rowsOut.slice(1)
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => {
      const record = {};
      header.forEach((name, index) => { record[name] = (r[index] ?? '').trim(); });
      return record;
    });
}

// ---------- Время ----------

// «Сейчас» в часовом поясе страны, а не телефона. Водитель едет по Испании
// с телефоном на латвийском времени — без пересчёта светофор врал бы на час.
function nowIn(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type).value;
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      minutes: Number(get('hour')) * 60 + Number(get('minute')),
    };
  } catch {
    // Неизвестный часовой пояс — падать нельзя, считаем по времени телефона.
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      minutes: d.getHours() * 60 + d.getMinutes(),
    };
  }
}

const toMinutes = (t) => {
  if (!t) return null;
  const [h, m] = t.split(':');
  return Number(h) * 60 + Number(m);
};

function isoPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function humanDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${WEEKDAYS[date.getDay()]}, ${d} ${MONTHS[m - 1]}`;
}

// ---------- Данные ----------

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeCache(csv) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ csv, at: Date.now() }));
  } catch { /* приватный режим или нет места — не критично */ }
}

function readRoute() {
  try {
    const raw = localStorage.getItem(ROUTE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function writeRoute(codes) {
  try { localStorage.setItem(ROUTE_KEY, JSON.stringify(codes)); } catch { /* не критично */ }
}

async function load() {
  if (rows) return true;

  // cache: 'no-store' — как в FuelInstruction: правка в таблице должна быть
  // видна водителю сразу, без ожидания, пока протухнет браузерный кэш.
  try {
    const res = await fetch(CALENDAR_CSV, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const csv = await res.text();
    rows = parseCSV(csv);
    fetchedAt = Date.now();
    fromCache = false;
    writeCache(csv);
    return true;
  } catch {
    const cached = readCache();
    if (cached) {
      rows = parseCSV(cached.csv);
      fetchedAt = cached.at;
      fromCache = true;
      return true;
    }
    el.body.innerHTML = `<p class="bans__empty">Нет связи, и сохранённых данных тоже нет.<br>
      Подключитесь к интернету и откройте экран ещё раз.</p>`;
    return false;
  }
}

// ---------- Выборки ----------

function countries() {
  const seen = new Map();
  rows.forEach((r) => {
    if (!seen.has(r.country)) {
      seen.set(r.country, { code: r.country, name: r.country_ru, flag: r.flag, tz: r.tz });
    }
  });
  return [...seen.values()];
}

function visibleCountries() {
  const all = countries();
  if (!onlyRoute) return all;
  const route = readRoute();
  if (!route.length) return all;
  return all.filter((c) => route.includes(c.code));
}

const forDay = (code, iso) => rows.filter((r) => r.country === code && r.date === iso);
const permanentFor = (code) => rows.filter((r) => r.country === code && !r.date);

// Состояние страны на конкретный день: цвет светофора и подпись.
function status(country, iso, isToday) {
  const day = forDay(country.code, iso);
  const bans = day.filter((r) => r.severity === 'ban');
  const warnings = day.filter((r) => r.severity === 'warning');

  if (!bans.length) {
    if (warnings.length) {
      return { light: 'warn', label: warnings[0].title_ru, rows: day };
    }
    return { light: 'ok', label: 'можно ехать', rows: day };
  }

  const windows = bans.map((r) => ({
    row: r,
    from: r.all_day === 'TRUE' ? 0 : toMinutes(r.time_from),
    to: r.all_day === 'TRUE' ? 1440 : toMinutes(r.time_to),
  })).filter((w) => w.from !== null && w.to !== null)
    .sort((a, b) => a.from - b.from);

  if (!windows.length) {
    return { light: 'ban', label: bans[0].title_ru, rows: day };
  }

  if (!isToday) {
    const first = windows[0];
    const text = first.row.all_day === 'TRUE'
      ? 'весь день'
      : `${first.row.time_from}–${first.row.time_to}`;
    return { light: 'ban', label: text, rows: day };
  }

  const now = nowIn(country.tz);
  const active = windows.find((w) => now.minutes >= w.from && now.minutes < w.to);
  if (active) {
    const until = active.row.all_day === 'TRUE' ? 'до конца суток' : `до ${active.row.time_to}`;
    return { light: 'ban', label: `сейчас запрет, ${until}`, rows: day };
  }

  const upcoming = windows.find((w) => now.minutes < w.from);
  if (upcoming) {
    return { light: 'soon', label: `запрет с ${upcoming.row.time_from}`, rows: day };
  }
  return { light: 'ok', label: 'запрет на сегодня закончился', rows: day };
}

// ---------- Отрисовка ----------

const LIGHT_ICON = { ban: '🔴', soon: '🟠', warn: '🟡', ok: '🟢' };

function rowDetailHTML(r) {
  const window = r.date
    ? (r.all_day === 'TRUE' ? 'весь день'
      : (r.time_from && r.time_to ? `${r.time_from}–${r.time_to}` : 'по отдельным участкам'))
    : (r.time_from && r.time_to ? `${r.time_from}–${r.time_to}` : 'постоянно');

  const weight = r.weight_min_t && Number(r.weight_min_t) > 0
    ? `<span class="bans__chip">от ${esc(String(r.weight_min_t).replace('.', ','))} т</span>` : '';
  const roads = r.roads ? `<span class="bans__chip">${esc(r.roads)}</span>` : '';
  const link = r.source_url
    ? `<a class="bans__source" href="${esc(r.source_url)}" target="_blank" rel="noopener">Официальный источник ↗</a>`
    : '';

  return `<div class="bans__detail bans__detail--${esc(r.severity)}">
      <div class="bans__detail-head">
        <strong>${esc(r.title_ru)}</strong>
        <span class="bans__window">${esc(window)}</span>
      </div>
      <div class="bans__chips">${weight}${roads}</div>
      ${r.note_ru ? `<p class="bans__note">${esc(r.note_ru).replace(/\n/g, '<br>')}</p>` : ''}
      ${link}
    </div>`;
}

function dayBlockHTML(iso, heading, isToday) {
  const list = visibleCountries().map((country) => {
    const state = status(country, iso, isToday);
    const isOpen = openCountry === country.code;
    const details = isOpen
      ? `<div class="bans__details">
           ${state.rows.map(rowDetailHTML).join('')}
           ${permanentFor(country.code).map(rowDetailHTML).join('')}
         </div>`
      : '';
    return `<div class="bans__country">
        <button class="bans__row bans__row--${state.light}" type="button"
                data-country="${esc(country.code)}" aria-expanded="${isOpen}">
          <span class="bans__light">${LIGHT_ICON[state.light]}</span>
          <span class="bans__name">${esc(country.flag)} ${esc(country.name)}</span>
          <span class="bans__label">${esc(state.label)}</span>
        </button>
        ${details}
      </div>`;
  }).join('');

  return `<section class="bans__day">
      <h2 class="bans__day-title">${esc(heading)}</h2>
      ${list || '<p class="bans__empty">Ни одной страны не выбрано.</p>'}
    </section>`;
}

function stripHTML() {
  const days = Array.from({ length: 14 }, (_, i) => isoPlus(i));
  const list = visibleCountries().map((country) => {
    const cells = days.map((iso) => {
      const day = forDay(country.code, iso);
      const level = day.some((r) => r.severity === 'ban') ? 'ban'
        : day.some((r) => r.severity === 'warning') ? 'warn' : 'ok';
      const [, , dd] = iso.split('-');
      return `<span class="bans__cell bans__cell--${level}" title="${esc(iso)}">${dd}</span>`;
    }).join('');
    return `<div class="bans__strip-row">
        <span class="bans__strip-code">${esc(country.flag)} ${esc(country.code)}</span>
        <span class="bans__strip-cells">${cells}</span>
      </div>`;
  }).join('');

  return `<section class="bans__day">
      <h2 class="bans__day-title">Ближайшие 14 дней</h2>
      <div class="bans__strip">${list}</div>
      <p class="bans__legend">
        <span class="bans__cell bans__cell--ban"></span> запрет
        <span class="bans__cell bans__cell--warn"></span> ограничения
        <span class="bans__cell bans__cell--ok"></span> свободно
      </p>
    </section>`;
}

function routeHTML() {
  const route = readRoute();
  const list = countries().map((c) => {
    const checked = route.includes(c.code) ? ' checked' : '';
    return `<label class="bans__route-item">
        <input type="checkbox" value="${esc(c.code)}"${checked}>
        <span>${esc(c.flag)} ${esc(c.name)}</span>
      </label>`;
  }).join('');
  return `<section class="bans__day">
      <h2 class="bans__day-title">Мой маршрут</h2>
      <p class="bans__hint">Отметьте страны своей поездки — на экране останутся только они.</p>
      <div class="bans__route" id="bans-route">${list}</div>
    </section>`;
}

function paintMeta() {
  const when = fetchedAt
    ? new Date(fetchedAt).toLocaleString('ru-RU',
      { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';
  el.meta.innerHTML = fromCache
    ? `<span class="bans__offline">Нет связи</span> показаны сохранённые данные от ${esc(when)}`
    : `Обновлено ${esc(when)}`;
}

function paint() {
  paintMeta();

  const today = isoPlus(0);
  const tomorrow = isoPlus(1);

  el.body.innerHTML = [
    dayBlockHTML(today, `Сегодня, ${humanDate(today)}`, true),
    dayBlockHTML(tomorrow, `Завтра, ${humanDate(tomorrow)}`, false),
    stripHTML(),
    routeHTML(),
    `<p class="bans__disclaimer">
       Справочная информация. Правила меняются, а местные и региональные
       ограничения сюда не входят — перед выездом сверяйтесь с официальным
       источником по ссылке в карточке страны.
     </p>`,
  ].join('');
}

// ---------- События ----------

el.body.addEventListener('click', (e) => {
  const button = e.target.closest('.bans__row');
  if (!button) return;
  const code = button.dataset.country;
  openCountry = openCountry === code ? null : code;
  paint();
});

el.body.addEventListener('change', (e) => {
  if (!e.target.matches('#bans-route input')) return;
  const checked = [...el.body.querySelectorAll('#bans-route input:checked')]
    .map((input) => input.value);
  writeRoute(checked);
  if (onlyRoute) paint();
});

el.tabs.addEventListener('click', (e) => {
  const button = e.target.closest('[data-mode]');
  if (!button) return;
  onlyRoute = button.dataset.mode === 'route';
  el.tabs.querySelectorAll('[data-mode]').forEach((b) => {
    b.classList.toggle('is-active', b === button);
  });
  paint();
});

el.close.addEventListener('click', () => {
  // Ровно как в guide.js: не history.back(), иначе при заходе по прямой ссылке
  // уходим из приложения совсем.
  location.hash = '#/';
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.root.hidden) location.hash = '#/';
});

// ---------- Показ / скрытие ----------

function show() {
  clearTimeout(closeTimer);
  el.root.classList.remove('is-closing');
  el.root.hidden = false;
  document.body.classList.add('is-locked');

  // Тот же приём, что в guide.js: кнопка калькулятора визуально перекрыта
  // z-index'ом, но без hidden остаётся в tab-order и ловит фокус позади экрана.
  const fab = document.getElementById('calc-fab');
  if (fab) fab.hidden = true;

  // setTimeout, а не rAF — как в guide.js: rAF не срабатывает в фоновой
  // вкладке, а телефон водителя может быть заблокирован в этот момент.
  el.root.classList.add('is-opening');
  setTimeout(() => el.root.classList.remove('is-opening'), 20);
}

function hide() {
  const fab = document.getElementById('calc-fab');
  if (fab) fab.hidden = false;

  if (el.root.hidden || el.root.classList.contains('is-closing')) return;

  // Блокировку скролла снимаем только если её не держит открытая карточка.
  const viewer = document.getElementById('viewer');
  if (!viewer || viewer.hidden) document.body.classList.remove('is-locked');

  el.root.classList.add('is-closing');
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    el.root.hidden = true;
    el.root.classList.remove('is-closing');
  }, 220);
}

async function syncFromHash() {
  if (location.hash.slice(2).split('/')[0] !== 'bans') { hide(); return; }
  show();
  if (await load()) paint();
}

window.addEventListener('hashchange', syncFromHash);
syncFromHash(); // прямой заход по ссылке, а не только по событию

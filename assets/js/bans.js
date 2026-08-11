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

import { FLAGS } from './flags.js?v=3';

const CACHE_KEY = 'di:bans';        // последний удачный ответ — на случай роуминга
const ROUTE_KEY = 'di:bans:route';  // выбранные водителем страны
const PERIOD_KEY = 'di:bans:period'; // выбранный период поездки
const TIP_KEY = 'di:bans:tip';      // подсказку про маршрут уже закрывали
const CARGO_KEY = 'di:bans:cargo';  // выбранный груз (Фаза 6)

// Коды груза и их русские подписи — те же тексты, что в CARGO_CODES
// (TRUCK_BANS_EU/config.py). Отдельная копия по той же причине, что и
// WEEKDAYS/plural(): это перевод кода в текст для показа, а не расчёт
// запрета — какие коды акт освобождает, решает и публикует робот.
const CARGO_LABELS = {
  fruit_veg: 'фрукты и овощи',
  flowers: 'цветы',
  frozen: 'заморозка',
  dairy: 'молочные продукты',
  meat_fish: 'мясо и рыба',
  live_animals: 'живые животные',
  combined: 'комбинированный транспорт',
  medicine: 'лекарства',
  fuel: 'топливо',
  emergency: 'аварийные и спасательные службы',
};

// Тумблеры на экране — подмножество кодов, которым реально управляет
// водитель. Порядок и состав = CARGO_TOGGLES в config.py.
const CARGO_TOGGLES = ['fruit_veg', 'flowers', 'frozen'];

// Сколько первых стран (по country_rank из таблицы) показывать всегда.
// Остальные прячутся в блок «Другие страны». Само значение — вопрос вёрстки
// («сколько строк влезает до сгиба»), поэтому живёт здесь, а не в данных;
// а вот ПОРЯДОК стран приходит из таблицы колонкой country_rank.
// 11.08.2026: было 8. Люксембург поднят в постоянный блок по просьбе
// владельца — машины идут через него транзитом часто, а запрет там как раз
// транзитный. Значение обязано совпадать с PRIMARY_COUNTRIES в config.py.
const PRIMARY_RANK = 9;

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
let openCountry = null; // раскрытая карточка страны, ключ «дата|код»
let legendOpen = false; // раскрыт справочник «флаг — код — название»
let othersOpen = false; // раскрыт блок «Другие страны»
let calendarOpen = false; // раскрыт календарь на дни за пределами периода поездки
let closeTimer = null;
let period = null;      // выбранный период поездки, см. readPeriod()
let openDays = new Set(); // раскрытые дни в «дальней» части периода и в календаре
let scrollTarget = null;  // день, к которому нужно прокрутить после перерисовки

// Последняя дата, которая реально есть в календаре. Всё, что дальше, —
// НЕ «можно ехать», а «мы ещё не считали». Без этой границы экран показывал бы
// зелёный свет на любую дату, в том числе если робот вообще перестанет
// работать: пустой день и свободный день выглядели одинаково.
let dataMaxDate = '';

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

// «15 августа» — для фраз внутри предложения, где день недели только мешает.
function shortDate(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

// Пятница/суббота/воскресенье — в скобках после даты: именно на эти дни чаще
// всего приходятся запреты, и водителю так проще выцепить их взглядом
// в свёрнутом списке дней, не открывая каждую строку.
const WEEKEND_TAG = { 0: 'воскресенье', 5: 'пятница', 6: 'суббота' };

function shortDateWithWeekend(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const tag = WEEKEND_TAG[new Date(y, m - 1, d).getDay()];
  return tag ? `${shortDate(iso)} (${tag})` : shortDate(iso);
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

// «Обычный груз» — пустой массив, отдельной записи под него нет: кнопка
// просто рисуется активной, когда набор пуст (см. cargoHTML()).
function readCargo() {
  try {
    const raw = localStorage.getItem(CARGO_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function writeCargo(codes) {
  try { localStorage.setItem(CARGO_KEY, JSON.stringify(codes)); } catch { /* не критично */ }
}

function readTipDismissed() {
  try { return localStorage.getItem(TIP_KEY) === '1'; } catch { return false; }
}

function dismissTip() {
  try { localStorage.setItem(TIP_KEY, '1'); } catch { /* не критично */ }
}

// Период хранится в localStorage, а НЕ в адресной строке: адрес у нас — это
// роутер экранов, и даты в нём создавали бы лишние записи истории (кнопка
// «Назад» переставала бы закрывать экран) и протухали бы в закладке.
//
// При чтении период пересчитывается заново: «3 дня», сохранённые вчера,
// означают следующие три дня, а не вчерашние. Свои даты из прошлого — сбрасываем.
function readPeriod() {
  try {
    const raw = localStorage.getItem(PERIOD_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || !saved.preset) return null;
    if (saved.preset !== 'custom') return { preset: saved.preset };
    const today = isoPlus(0);
    if (!saved.from || !saved.to || saved.to < today) return null;
    return { preset: 'custom', from: saved.from < today ? today : saved.from, to: saved.to };
  } catch { return null; }
}

function writePeriod(value) {
  try {
    if (value) localStorage.setItem(PERIOD_KEY, JSON.stringify(value));
    else localStorage.removeItem(PERIOD_KEY);
  } catch { /* не критично */ }
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
    noteDataRange();
    fetchedAt = Date.now();
    fromCache = false;
    writeCache(csv);
    return true;
  } catch {
    const cached = readCache();
    if (cached) {
      rows = parseCSV(cached.csv);
      noteDataRange();
      fetchedAt = cached.at;
      fromCache = true;
      return true;
    }
    el.body.innerHTML = `<p class="bans__empty">Нет связи, и сохранённых данных тоже нет.<br>
      Подключитесь к интернету и откройте экран ещё раз.</p>`;
    return false;
  }
}

// Докуда посчитан календарь. Строки без даты — постоянные факты, они границу
// не задают, поэтому берём максимум только по заполненным датам.
function noteDataRange() {
  dataMaxDate = rows.reduce((max, r) => (r.date && r.date > max ? r.date : max), '');
}

// ---------- Период поездки ----------

function nextIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d + 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Крайняя дата, которую вообще можно выбрать: дальше расчёта нет.
const lastPickable = () => dataMaxDate || isoPlus(29);

// Дни, которые сейчас показываем. По умолчанию — сегодня и завтра, как было.
function periodDays() {
  const p = period || { preset: 'default' };

  if (p.preset === 'custom' && p.from && p.to) {
    const days = [];
    // Ограничение в 31 день — страховка от кривой даты в хранилище,
    // чтобы цикл не ушёл в бесконечность и телефон не завис.
    for (let d = p.from; d <= p.to && days.length < 31; d = nextIso(d)) days.push(d);
    return days;
  }

  const count = p.preset === '3' ? 3 : p.preset === '7' ? 7 : 2;
  return Array.from({ length: count }, (_, i) => isoPlus(i));
}

function dayHeading(iso) {
  if (iso === isoPlus(0)) return `Сегодня, ${humanDate(iso)}`;
  if (iso === isoPlus(1)) return `Завтра, ${humanDate(iso)}`;
  const text = humanDate(iso);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------- Выборки ----------

// Порядок стран задаёт таблица колонкой country_rank, а не порядок строк в CSV.
// Раньше порядок брался «как встретилось», и это работало случайно: у каждой
// страны есть постоянный факт, и он шёл первым. У страны без такого факта
// порядок уехал бы. Теперь он явный.
function countries() {
  const seen = new Map();
  rows.forEach((r) => {
    const rank = Number(r.country_rank) || 99;
    const known = seen.get(r.country);
    if (!known) {
      seen.set(r.country, {
        code: r.country, name: r.country_ru, flag: r.flag, tz: r.tz, rank,
      });
    } else if (known.rank === 99 && rank !== 99) {
      // Первой встретилась строка живого источника без ранга — доберём позже.
      known.rank = rank;
    }
  });
  return [...seen.values()].sort((a, b) => a.rank - b.rank);
}

// Делит страны на «всегда видны» и «спрятаны под кнопкой».
// Страна, отмеченная в маршруте, поднимается наверх, даже если она не из
// первой восьмёрки: водитель сам сказал, что едет через неё.
function splitCountries() {
  const all = countries();
  const route = readRoute();

  if (onlyRoute) {
    const picked = route.length ? all.filter((c) => route.includes(c.code)) : all;
    return { primary: picked, others: [] };
  }

  const isPrimary = (c) => c.rank <= PRIMARY_RANK || route.includes(c.code);
  return {
    primary: all.filter(isPrimary),
    others: all.filter((c) => !isPrimary(c)),
  };
}

// Флаг страны. Единственное место, где разметка отдаётся БЕЗ экранирования.
// Это безопасно: code — не данные из таблицы, а ключ поиска в жёстко заданном
// объекте FLAGS. Неизвестный ключ отдаёт экранированный текстовый запасной
// вариант, поэтому пути для подстановки чужого HTML здесь нет.
function flagSVG(code) {
  return FLAGS[code] || `<span class="bans__flag-text">${esc(code)}</span>`;
}

const forDay = (code, iso) => rows.filter((r) => r.country === code && r.date === iso);
const permanentFor = (code) => rows.filter((r) => r.country === code && !r.date);

const parseCargoList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// Как выбранный груз соотносится с ОДНИМ рядом-запретом. Только сравнение
// множеств — какие коды акт освобождает, уже решил и опубликовал робот
// (cargo_exempt/cargo_permit/cargo_checked), здесь никакой логики закона нет.
//
//   'exempt'    — весь выбранный груз освобождён актом, без бумаг
//   'unchecked' — груз по этому запрету ещё не сверен с актом
//   'permit'    — освобождение есть, но только по разрешению — красный остаётся
//   'none'      — сверено, автоматических исключений на выбранный груз нет
function cargoState(row, cargo) {
  const exempt = parseCargoList(row.cargo_exempt);
  if (cargo.every((code) => exempt.includes(code))) return 'exempt';
  if (!row.cargo_checked) return 'unchecked';
  const permit = parseCargoList(row.cargo_permit);
  if (cargo.some((code) => permit.includes(code))) return 'permit';
  return 'none';
}

// Состояние страны на конкретный день: цвет светофора и подпись.
function status(country, iso, isToday) {
  // Дальше посчитанного горизонта отвечаем «не знаю», а не «можно ехать».
  // Раньше день без строк молча давал зелёный свет — и если бы робот встал,
  // экран бесконечно показывал бы «можно ехать» по всей Европе.
  if (dataMaxDate && iso > dataMaxDate) {
    return { light: 'unknown', label: 'нет данных на эту дату', rows: [] };
  }

  const day = forDay(country.code, iso);
  const bans = day.filter((r) => r.severity === 'ban');
  const warnings = day.filter((r) => r.severity === 'warning');

  if (!bans.length) {
    if (warnings.length) {
      return { light: 'warn', label: warnings[0].title_ru, rows: day };
    }
    return { light: 'ok', label: 'можно ехать', rows: day };
  }

  // Освобождение по грузу — только если водитель выбрал конкретный вид.
  // «Обычный груз» (пустой набор) эту проверку вообще не запускает — экран
  // ведёт себя как раньше. Правило — «освобождён ВЕСЬ груз», не «хоть
  // что-то»: везёт фрукты и заморозку, а акт освобождает только фрукты —
  // рейс остаётся под запретом.
  let cargoNote = null;
  const cargo = readCargo();
  if (cargo.length) {
    const states = bans.map((r) => cargoState(r, cargo));
    if (states.every((s) => s === 'exempt')) {
      return { light: 'exempt', label: 'груз освобождён', rows: day };
    }
    if (states.some((s) => s === 'unchecked')) {
      return { light: 'ban', label: 'нет данных об исключениях', rows: day };
    }
    if (states.some((s) => s === 'permit')) {
      cargoNote = 'только по разрешению';
    }
  }

  const withCargo = (text) => (cargoNote ? `${text} · ${cargoNote}` : text);

  const windows = bans.map((r) => ({
    row: r,
    from: r.all_day === 'TRUE' ? 0 : toMinutes(r.time_from),
    to: r.all_day === 'TRUE' ? 1440 : toMinutes(r.time_to),
  })).filter((w) => w.from !== null && w.to !== null)
    .sort((a, b) => a.from - b.from);

  if (!windows.length) {
    return { light: 'ban', label: withCargo(bans[0].title_ru), rows: day };
  }

  if (!isToday) {
    const first = windows[0];
    const text = first.row.all_day === 'TRUE'
      ? 'весь день'
      : `${first.row.time_from}–${first.row.time_to}`;
    return { light: 'ban', label: withCargo(text), rows: day };
  }

  const now = nowIn(country.tz);
  const active = windows.find((w) => now.minutes >= w.from && now.minutes < w.to);
  if (active) {
    const until = active.row.all_day === 'TRUE' ? 'до конца суток' : `до ${active.row.time_to}`;
    return { light: 'ban', label: withCargo(`сейчас запрет, ${until}`), rows: day };
  }

  const upcoming = windows.find((w) => now.minutes < w.from);
  if (upcoming) {
    return { light: 'soon', label: withCargo(`запрет с ${upcoming.row.time_from}`), rows: day };
  }
  return { light: 'ok', label: 'запрет на сегодня закончился', rows: day };
}

// ---------- Отрисовка ----------

const LIGHT_ICON = { ban: '🔴', soon: '🟠', warn: '🟡', ok: '🟢', unknown: '⚪', exempt: '🔵' };

// Что известно про исключения по грузу для ОДНОГО ряда — показывается в
// карточке независимо от того, какой груз сейчас выбран водителем, чтобы
// можно было заранее посмотреть условия. Только показ трёх состояний,
// которые публикует робот (cargo_checked/cargo_exempt/cargo_permit) — сама
// проверка принадлежности множеству живёт в cargoState(), здесь её нет.
function cargoDetailHTML(r) {
  if (r.severity !== 'ban') return '';

  if (!r.cargo_checked) {
    return `<p class="bans__cargo-note bans__cargo-note--unchecked">
      Исключения по грузу для этого запрета ещё не сверены с актом.</p>`;
  }

  const exempt = parseCargoList(r.cargo_exempt).map((c) => CARGO_LABELS[c] || c);
  const permit = parseCargoList(r.cargo_permit).map((c) => CARGO_LABELS[c] || c);
  const parts = [];
  if (exempt.length) {
    parts.push(`<p class="bans__cargo-note bans__cargo-note--exempt">Без разрешения: ${esc(exempt.join(', '))}</p>`);
  }
  if (permit.length) {
    parts.push(`<p class="bans__cargo-note bans__cargo-note--permit">Только по разрешению: ${esc(permit.join(', '))}</p>`);
  }
  if (!exempt.length && !permit.length) {
    parts.push(`<p class="bans__cargo-note">Сверено ${esc(shortDate(r.cargo_checked))}: автоматических исключений по грузу нет.</p>`);
  }
  if (r.cargo_note_ru) {
    parts.push(`<p class="bans__cargo-note bans__cargo-note--detail">${esc(r.cargo_note_ru)}</p>`);
  }
  return parts.join('');
}

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
      ${cargoDetailHTML(r)}
      ${link}
    </div>`;
}

// Предложный падеж названия страны: «в Польше», «в Германии».
// Правило покрывает все 18 стран: «-ия» → «-ии», иначе «-а» → «-е».
// Нидерланды — единственное исключение (множественное число).
function inCountry(name) {
  if (name === 'Нидерланды') return 'Нидерландах';
  if (name.endsWith('ия')) return `${name.slice(0, -2)}ии`;
  if (name.endsWith('а')) return `${name.slice(0, -1)}е`;
  return name;
}

// Что показать в раскрытой карточке, когда на этот день запретов не нашлось.
// Важная тонкость: «запретов нет» и «можно ехать весь день» — РАЗНЫЕ вещи.
// У Австрии и Швейцарии есть постоянный ночной запрет, он лежит отдельной
// строкой без даты. Поэтому, если постоянные ограничения у страны есть,
// про «весь день» не пишем и отправляем читать их ниже.
function noBansHTML(country, iso, isToday, hasPermanent) {
  const when = isToday ? 'Сегодня' : (iso === isoPlus(1) ? 'Завтра' : shortDate(iso));
  const where = inCountry(country.name);
  const text = hasPermanent
    ? `${when} в ${where} запретов по дате нет. Но есть постоянные ограничения — смотрите ниже.`
    : `${when} в ${where} запретов нет — можно ехать весь день.`;
  return `<p class="bans__none">${esc(text)}</p>`;
}

function countryRowHTML(country, iso, isToday) {
  const state = status(country, iso, isToday);
  // Ключ раскрытия включает дату: иначе, раскрыв Германию в «Сегодня»,
  // водитель одновременно раскрывал её и в «Завтра».
  const key = `${iso}|${country.code}`;
  const isOpen = openCountry === key;

  const permanent = permanentFor(country.code);
  // Карточка раскрывается ВСЕГДА, даже у зелёной страны: водитель нажал —
  // он должен получить ответ, а не пустоту.
  let inner;
  if (state.light === 'unknown') {
    // Отдельный текст: «мы не считали» — это НЕ «запретов нет».
    inner = `<p class="bans__none bans__none--unknown">На ${esc(shortDate(iso))}
       расчёта ещё нет: календарь посчитан по ${esc(shortDate(dataMaxDate))}.
       Проверьте ближе к дате или сверьтесь с официальным источником.</p>`;
  } else if (state.rows.length) {
    inner = state.rows.map(rowDetailHTML).join('') + permanent.map(rowDetailHTML).join('');
  } else {
    inner = noBansHTML(country, iso, isToday, permanent.length > 0)
      + permanent.map(rowDetailHTML).join('');
  }

  const details = isOpen ? `<div class="bans__details">${inner}</div>` : '';

  return `<div class="bans__country">
      <button class="bans__row bans__row--${state.light}" type="button"
              data-act="country" data-key="${esc(key)}" aria-expanded="${isOpen}">
        <span class="bans__light">${LIGHT_ICON[state.light]}</span>
        <span class="bans__flag-wrap">${flagSVG(country.code)}</span>
        <span class="bans__name">${esc(country.name)}</span>
        <span class="bans__label">${esc(state.label)}</span>
      </button>
      ${details}
    </div>`;
}

function dayBlockHTML(iso, heading, isToday) {
  const { primary, others } = splitCountries();
  const list = primary.map((c) => countryRowHTML(c, iso, isToday)).join('');

  const othersBlock = others.length
    ? `<button class="bans__more${othersOpen ? ' is-open' : ''}" type="button"
               data-act="others" aria-expanded="${othersOpen}">
         <span class="bans__more-arrow" aria-hidden="true">▾</span>
         ${othersOpen ? 'Свернуть' : `Показать ещё ${others.length} стран`}
       </button>
       ${othersOpen ? others.map((c) => countryRowHTML(c, iso, isToday)).join('') : ''}`
    : '';

  return `<section class="bans__day">
      <h2 class="bans__day-title">${esc(heading)}</h2>
      ${list || '<p class="bans__empty">Ни одной страны не выбрано.</p>'}
      ${othersBlock}
    </section>`;
}

// Дни календаря ПОСЛЕ выбранного периода поездки, вплоть до горизонта
// расчёта. Не пересекается с periodDays(): период — это «мои даты», календарь
// внизу — «что там дальше», на случай, если рейс затянется или планы изменятся.
// Если период уже упирается в горизонт (выбрали «Свои даты» на месяц вперёд),
// календарь просто пуст — показывать за горизонтом нечего.
function calendarDays() {
  const days = periodDays();
  const horizon = lastPickable();
  const result = [];
  for (let d = nextIso(days[days.length - 1]); d <= horizon && result.length < 40; d = nextIso(d)) {
    result.push(d);
  }
  return result;
}

// «Худшее» состояние дня среди видимых стран — для одной клетки ленты обзора.
// Порядок важности: ⚪ нет данных и 🔴 запрет важнее, чем предупреждения;
// 🔵 «освобождён» — для этого рейса не опасно, но всё же не то же самое,
// что 🟢 «запрета нет вообще», поэтому стоит на ступень выше него.
const LIGHT_RANK = { ok: 0, exempt: 1, warn: 2, soon: 3, ban: 4, unknown: 5 };

function worstLight(iso) {
  const { primary } = splitCountries();
  return primary.reduce((worst, c) => {
    const light = status(c, iso, false).light;
    return LIGHT_RANK[light] > LIGHT_RANK[worst] ? light : worst;
  }, 'ok');
}

// Календарь сразу под «Когда еду»: лента обзора (для «одним взглядом найти
// чистое окно») + список дней с раскрытием, тот же приём, что и у «Дальше по
// маршруту» — переиспользуем daySummaryHTML целиком, не дублируем разметку.
// Свёрнут по умолчанию: это не первое, что нужно на экране.
function calendarHTML() {
  const days = calendarDays();
  if (!days.length) return '';
  const last = days[days.length - 1];
  const title = `Календарь до ${shortDate(last)}`;

  if (!calendarOpen) {
    return `<section class="bans__day">
        <button class="bans__more" type="button" data-act="calendar" aria-expanded="false">
          <span class="bans__more-arrow" aria-hidden="true">▾</span>
          ${esc(title)}
        </button>
      </section>`;
  }

  const ribbon = days.map((iso) => {
    const level = worstLight(iso);
    const [, , dd] = iso.split('-');
    return `<button class="bans__ribbon-cell bans__ribbon-cell--${level}" type="button"
               data-act="jump" data-day="${esc(iso)}" aria-label="${esc(shortDateWithWeekend(iso))}"
               >${dd}</button>`;
  }).join('');

  const lines = days.map(daySummaryHTML).join('');

  return `<section class="bans__day">
      <button class="bans__more is-open" type="button" data-act="calendar" aria-expanded="true">
        <span class="bans__more-arrow" aria-hidden="true">▾</span>
        Свернуть календарь
      </button>
      <p class="bans__hint">Нажмите на клетку в ленте, чтобы сразу открыть этот день.</p>
      <div class="bans__ribbon">${ribbon}</div>
      ${lines}
    </section>`;
}

function periodHTML() {
  const p = period || { preset: 'default' };
  const days = periodDays();
  const min = isoPlus(0);
  const max = lastPickable();

  const chip = (id, label) => `<button class="bans__preset${p.preset === id ? ' is-on' : ''}"
      type="button" data-act="preset" data-preset="${id}"
      aria-pressed="${p.preset === id}">${label}</button>`;

  // Нативный <input type="date">, а не свой календарь: он даёт правильную
  // клавиатуру на телефоне, знает язык системы и работает без интернета.
  const custom = p.preset === 'custom'
    ? `<div class="bans__dates">
         <label class="bans__date">с
           <input type="date" data-act="date" data-edge="from"
                  value="${esc(p.from || min)}" min="${esc(min)}" max="${esc(max)}">
         </label>
         <label class="bans__date">по
           <input type="date" data-act="date" data-edge="to"
                  value="${esc(p.to || min)}" min="${esc(min)}" max="${esc(max)}">
         </label>
       </div>`
    : '';

  const first = days[0];
  const last = days[days.length - 1];
  const summary = days.length > 1
    ? `${days.length} ${plural(days.length, 'день', 'дня', 'дней')}: ${shortDate(first)} — ${shortDate(last)}`
    : shortDate(first);

  return `<section class="bans__day bans__period">
      <h2 class="bans__day-title">Когда еду</h2>
      <div class="bans__presets">
        ${chip('default', 'Сегодня и завтра')}
        ${chip('3', '3 дня')}
        ${chip('7', 'Неделя')}
        ${chip('custom', 'Свои даты')}
      </div>
      ${custom}
      <p class="bans__hint bans__period-sum">${esc(summary)}. Расчёт есть по ${esc(shortDate(max))}.</p>
    </section>`;
}

// Русские склонения — как в остальном приложении (см. plural() в app.js;
// здесь своя копия, модуль намеренно ни от чего не зависит).
function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// Свёрнутая строка дня — для «дальней» части периода. Разворачивать все дни
// сразу нельзя: 30 дней × 8 стран телефон не потянет и читать это невозможно.
function daySummaryHTML(iso) {
  const { primary } = splitCountries();
  const isOpen = openDays.has(iso);
  const groups = { unknown: [], ban: [], soon: [], warn: [], exempt: [] };

  primary.forEach((c) => {
    const state = status(c, iso, iso === isoPlus(0));
    if (groups[state.light]) groups[state.light].push(c.code);
  });

  const parts = [];
  if (groups.unknown.length) parts.push('⚪ нет данных');
  if (groups.ban.length) parts.push(`🔴 ${groups.ban.join(' ')}`);
  if (groups.soon.length) parts.push(`🟠 ${groups.soon.join(' ')}`);
  if (groups.warn.length) parts.push(`🟡 ${groups.warn.join(' ')}`);
  if (groups.exempt.length) parts.push(`🔵 ${groups.exempt.join(' ')}`);
  const summary = parts.length ? parts.join(' · ') : '🟢 запретов нет';

  const body = isOpen
    ? primary.map((c) => countryRowHTML(c, iso, false)).join('')
    : '';

  return `<div class="bans__dayline${isOpen ? ' is-open' : ''}">
      <button class="bans__dayline-head" type="button" data-act="day" data-day="${esc(iso)}"
              aria-expanded="${isOpen}">
        <span class="bans__dayline-date">${esc(shortDateWithWeekend(iso))}</span>
        <span class="bans__dayline-sum">${esc(summary)}</span>
      </button>
      ${body}
    </div>`;
}

// Мини-инструкция для водителя. Показывается, пока не закрыли крестиком —
// после этого дальше не всплывает (di:bans:tip). Раздел «Мой маршрут» теперь
// самый первый на экране, и без единого предложения непонятно, зачем тут
// отмечать страны и что от этого изменится дальше по экрану.
function routeTipHTML() {
  if (readTipDismissed()) return '';
  return `<div class="bans__tip">
      <button class="bans__tip-close" type="button" data-act="tip-close"
              aria-label="Закрыть подсказку">×</button>
      <p><strong>Как это работает.</strong> Отметьте страны своей поездки —
      они останутся видны первыми на каждый день ниже. Чтобы скрыть остальные
      страны совсем, нажмите «Только мой маршрут» вверху экрана.</p>
    </div>`;
}

// Справочник «флаг — код — полное название». Заменяет прежнюю кнопку «i» на
// каждом чипе: 18 отдельных кнопок были лишними, а один свёрнутый список даёт
// тот же ответ. Раскрывается тем же приёмом, что и «Другие страны».
//
// Стоит в самом низу экрана, а не рядом с чипами: коды и так понятны
// большинству, справочник — просто на всякий случай, не для первого взгляда.
function routeLegendHTML() {
  const all = countries();
  const rows = all.map((c) => `<div class="bans__legend-row">
      ${flagSVG(c.code)}<strong>${esc(c.code)}</strong> — ${esc(c.name)}
    </div>`).join('');

  return `<section class="bans__day">
      <button class="bans__more${legendOpen ? ' is-open' : ''}" type="button"
               data-act="legend" aria-expanded="${legendOpen}">
          <span class="bans__more-arrow" aria-hidden="true">▾</span>
          ${legendOpen ? 'Свернуть' : 'Что означают коды стран?'}
        </button>
        ${legendOpen ? `<div class="bans__legend-list">${rows}</div>` : ''}
    </section>`;
}

function routeHTML() {
  const route = readRoute();
  const all = countries();

  const list = all.map((c) => {
    const on = route.includes(c.code);
    return `<button class="bans__chip-country${on ? ' is-on' : ''}" type="button"
          data-act="route" data-country="${esc(c.code)}"
          aria-pressed="${on}" aria-label="${esc(c.name)}">
        ${flagSVG(c.code)}<span class="bans__chip-code">${esc(c.code)}</span>
      </button>`;
  }).join('');

  const picked = route.length
    ? `<p class="bans__hint">Выбрано: ${route.length}. Нажмите «Только мой маршрут» вверху, чтобы оставить на экране только их.</p>`
    : `<p class="bans__hint">Нажмите на страны своей поездки.</p>`;

  return `<section class="bans__day bans__route-section">
      <h2 class="bans__day-title">Мой маршрут</h2>
      ${routeTipHTML()}
      ${picked}
      <div class="bans__route">${list}</div>
    </section>`;
}

// Тумблеры груза (Фаза 6 — ради этого всё). «Обычный груз» — пустой набор,
// у него нет собственной записи в di:bans:cargo, кнопка просто рисуется
// активной, когда массив пуст. Включение любого вида гасит «Обычный груз»
// само по себе (в массиве появляется код), выключение последнего — зажигает
// его обратно (массив снова пуст). Пустого состояния «ничего не выбрано»
// на экране никогда не бывает.
function cargoHTML() {
  const cargo = readCargo();
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const defaultBtn = `<button class="bans__cargo-toggle${cargo.length ? '' : ' is-on'}" type="button"
      data-act="cargo" data-code="" aria-pressed="${!cargo.length}">Обычный груз</button>`;

  const toggles = CARGO_TOGGLES.map((code) => {
    const on = cargo.includes(code);
    return `<button class="bans__cargo-toggle${on ? ' is-on' : ''}" type="button"
        data-act="cargo" data-code="${esc(code)}" aria-pressed="${on}">${esc(cap(CARGO_LABELS[code]))}</button>`;
  }).join('');

  return `<section class="bans__day bans__cargo-section">
      <h2 class="bans__day-title">Мой груз</h2>
      <div class="bans__cargo-row">${defaultBtn}${toggles}</div>
      <p class="bans__hint">🔵 Синий — запрет есть, но выбранный груз освобождён актом
        без специального разрешения. Это не отменяет обычные документы на груз
        (накладная, инвойс) — контроль вправе их спросить. Условия — в карточке
        страны.</p>
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

  // Перерисовываем тело целиком, поэтому запоминаем прокрутку: без этого
  // раскрытие страны или выбор страны в маршруте подбрасывает экран наверх.
  const keepScroll = el.body.scrollTop;

  const days = periodDays();
  const today = isoPlus(0);

  // Первые два дня — полными блоками (это то, что нужно прямо сейчас).
  // Остальные — свёрнутыми строками, разворачиваются по нажатию.
  const full = days.slice(0, 2)
    .map((iso) => dayBlockHTML(iso, dayHeading(iso), iso === today))
    .join('');

  const rest = days.length > 2
    ? `<section class="bans__day">
         <h2 class="bans__day-title">Дальше по маршруту</h2>
         ${days.slice(2).map(daySummaryHTML).join('')}
       </section>`
    : '';

  // «Мой маршрут» — первым: это главная фишка экрана, страны из маршрута
  // определяют, что водитель видит первым делом ниже по всем дням. «Мой
  // груз» — сразу за ним: это тоже «кто я» для этой поездки, до того, как
  // экран начнёт показывать светофоры по дням.
  el.body.innerHTML = [
    routeHTML(),
    cargoHTML(),
    periodHTML(),
    calendarHTML(),
    full,
    rest,
    routeLegendHTML(),
    `<p class="bans__disclaimer">
       Справочная информация. Правила меняются, а местные и региональные
       ограничения сюда не входят — перед выездом сверяйтесь с официальным
       источником по ссылке в карточке страны. Исключения по грузу сверены
       вручную с законами — для части стран сверки ещё нет, тогда честно
       показано «нет данных», а не зелёный свет.
     </p>`,
  ].join('');

  // Прыжок из ленты обзора — к своей строке дня, а не куда попало по прокрутке.
  if (scrollTarget) {
    const target = el.body.querySelector(`[data-day="${CSS.escape(scrollTarget)}"].bans__dayline-head`);
    scrollTarget = null;
    if (target) {
      target.scrollIntoView({ block: 'center' });
      return;
    }
  }

  el.body.scrollTop = keepScroll;
}

// ---------- События ----------

// Один обработчик на всё тело экрана: разбираем по data-act.
// Кнопок несколько разных видов, и часть из них — соседи внутри одной строки
// (например, раскрытие дня и его содержимое) — вложенная <button> внутри
// <button> невалидна. closest() поднимается вверх от места клика, поэтому
// самая внутренняя подходящая кнопка всегда выигрывает у внешней.
el.body.addEventListener('click', (e) => {
  const hit = e.target.closest('[data-act]');
  if (!hit) return;

  switch (hit.dataset.act) {
    case 'country': {
      const key = hit.dataset.key;
      openCountry = openCountry === key ? null : key;
      break;
    }
    case 'legend':
      legendOpen = !legendOpen;
      break;
    case 'tip-close':
      dismissTip();
      break;
    case 'route': {
      const code = hit.dataset.country;
      const route = readRoute();
      writeRoute(route.includes(code)
        ? route.filter((x) => x !== code)
        : [...route, code]);
      break;
    }
    case 'others':
      othersOpen = !othersOpen;
      break;
    case 'calendar':
      calendarOpen = !calendarOpen;
      break;
    case 'cargo': {
      const code = hit.dataset.code;
      const current = readCargo();
      const next = !code
        ? []
        : current.includes(code) ? current.filter((x) => x !== code) : [...current, code];
      writeCargo(next);
      break;
    }
    case 'day': {
      const iso = hit.dataset.day;
      if (openDays.has(iso)) openDays.delete(iso);
      else openDays.add(iso);
      break;
    }
    case 'jump': {
      // Клетка ленты обзора: открыть день и прокрутить к нему, а не только
      // раскрыть — иначе пришлось бы искать раскрывшуюся строку глазами.
      const iso = hit.dataset.day;
      openDays.add(iso);
      scrollTarget = iso;
      break;
    }
    case 'preset': {
      const preset = hit.dataset.preset;
      if (preset === 'custom') {
        const from = isoPlus(0);
        const to = periodDays().slice(-1)[0] || from;
        period = { preset: 'custom', from, to: to > lastPickable() ? lastPickable() : to };
      } else {
        period = preset === 'default' ? null : { preset };
      }
      writePeriod(period);
      openDays = new Set();
      break;
    }
    default:
      return;
  }

  paint();
});

// Даты — отдельным обработчиком: у <input> это событие change, не click.
// Слушаем именно change, а не input: значение приходит уже готовым, и
// перерисовка не выдёргивает фокус на середине набора.
el.body.addEventListener('change', (e) => {
  const input = e.target.closest('input[data-act="date"]');
  if (!input) return;

  const p = period && period.preset === 'custom'
    ? { ...period }
    : { preset: 'custom', from: isoPlus(0), to: isoPlus(0) };

  p[input.dataset.edge] = input.value;

  // Перепутанные местами даты молча меняем местами, а не ругаемся.
  if (p.from && p.to && p.from > p.to) {
    const swap = p.from; p.from = p.to; p.to = swap;
  }
  const min = isoPlus(0);
  const max = lastPickable();
  if (p.from < min) p.from = min;
  if (p.to > max) p.to = max;

  period = p;
  writePeriod(period);
  openDays = new Set();
  paint();
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
  // Период перечитываем при каждом открытии, а не один раз при загрузке:
  // приложение живёт на телефоне сутками, и «3 дня» должны отсчитываться
  // от сегодня, а не от дня, когда водитель их выбрал.
  period = readPeriod();
  openDays = new Set();
  if (await load()) paint();
}

window.addEventListener('hashchange', syncFromHash);
syncFromHash(); // прямой заход по ссылке, а не только по событию

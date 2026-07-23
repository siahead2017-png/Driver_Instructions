// Калькулятор времени до точки: расстояние + скорость + паузы -> ЧЧ:ММ и время прибытия.
// Плюс вкладка «Баки»: остаток топлива по замеру уровня в сантиметрах.
// Самодостаточный модуль: открывается плавающей кнопкой, не трогает hash-роутинг app.js.

const fab = document.getElementById('calc-fab');
const modal = document.getElementById('calc');
const backdrop = document.getElementById('calc-backdrop');
const closeBtn = document.getElementById('calc-close');
const doneBtn = document.getElementById('calc-done');
const resetBtn = document.getElementById('calc-reset');

// Вкладки: «Время и топливо» / «Баки»
const tabTrip = document.getElementById('calc-tab-trip');
const tabTanks = document.getElementById('calc-tab-tanks');
const panelTrip = document.getElementById('calc-panel-trip');
const panelTanks = document.getElementById('calc-panel-tanks');

const distEl = document.getElementById('calc-dist');
const speedEl = document.getElementById('calc-speed');
const ehEl = document.getElementById('calc-eh');
const emEl = document.getElementById('calc-em');
// Чекбокс-чипы пауз (24/45/2 ч). Девятки считаются отдельно степпером.
const pauseEls = ['calc-p24', 'calc-p45', 'calc-p2'].map((id) => document.getElementById(id));

// Степпер «Пауза 9 ч»: девяток в рейсе бывает 2–3, поэтому не чекбокс, а счётчик.
const p9Chip = document.getElementById('calc-p9-chip');
const p9Main = document.getElementById('calc-p9-main');
const p9Minus = document.getElementById('calc-p9-minus');
const p9Plus = document.getElementById('calc-p9-plus');
const p9X = document.getElementById('calc-p9-x');
let p9Count = 0; // 0..P9_MAX

const timeEl = document.getElementById('calc-time');
const arrivalEl = document.getElementById('calc-arrival');
const breakdownEl = document.getElementById('calc-breakdown');

// Топливо (опционально, по галочке)
const fuelOn = document.getElementById('calc-fuel-on');
const fuelBlock = document.getElementById('calc-fuel');
const truckEl = document.getElementById('calc-truck');
const trailerEl = document.getElementById('calc-trailer');
const idleEl = document.getElementById('calc-idle');
const fuelTruckEl = document.getElementById('calc-fuel-truck');
const fuelIdleRow = document.getElementById('calc-fuel-idle-row');
const fuelIdleEl = document.getElementById('calc-fuel-idle');
const fuelTruckTotalEl = document.getElementById('calc-fuel-truck-total');
const fuelTrailerEl = document.getElementById('calc-fuel-trailer');

// Баки
const brandEls = [...document.querySelectorAll('input[name="calc-brand"]')];
const tank1El = document.getElementById('calc-tank1');
const tank2El = document.getElementById('calc-tank2');
const tank1LEl = document.getElementById('calc-tank1-l');
const tank2LEl = document.getElementById('calc-tank2-l');
const tank1LabelEl = document.getElementById('calc-tank1-label');
const tank2LabelEl = document.getElementById('calc-tank2-label');
const tank1NameEl = document.getElementById('calc-tank1-name');
const tank2NameEl = document.getElementById('calc-tank2-name');
const tankNoteEl = document.getElementById('calc-tank-note');
const tanksTotalEl = document.getElementById('calc-tanks-total');

const DEFAULT_SPEED = 70;
const DEFAULT_TRUCK = 27;    // л/100 км
const DEFAULT_TRAILER = 1.8; // л/ч (холодильная установка)
const IDLE_LPH = 2.5;        // л/ч на стоянке с работающим двигателем (водителю не показываем)
const P9_MAX = 5;            // максимум девяток в степпере

// Баки по маркам: ёмкость (для подписи), литров на 1 см замера, памятка.
// Данные владельца (июль 2026). Сходимость проверена: ёмкость ~ полный бак (см) × л/см.
// У DAF бак 1 коэффициент выведен из ёмкости: 845 л / 60 см = 14,08 (владелец подтвердил ёмкость).
const TANKS = {
  man: {
    note: 'Линейка должна быть зафиксирована на отметке 70 см. Полный бак — 67 см.',
    tanks: [
      { cap: 580, lPerCm: 8.65 },
      { cap: 580, lPerCm: 8.65 }, // у MAN оба бака одинаковые
    ],
  },
  daf: {
    note: 'Линейка должна быть зафиксирована на отметке 64 см. Полный бак — 60 см.',
    tanks: [
      { cap: 845, lPerCm: 14.08 },
      { cap: 355, lPerCm: 5.58 },
    ],
  },
  volvo: {
    note: 'Линейка должна быть зафиксирована на отметке 71 см. Полный бак — 65 см.',
    tanks: [
      { cap: 570, lPerCm: 8.77 },
      { cap: 650, lPerCm: 10 },
    ],
  },
};

// Сантиметры замеров храним по каждой марке отдельно:
// водитель мог мерить чужую машину и вернуться к своей.
let tankCm = { man: ['', ''], daf: ['', ''], volvo: ['', ''] };

function currentBrand() {
  return brandEls.find((el) => el.checked)?.value ?? 'man';
}

// ---------- Хранилище (ключ отдельный от «недавних»; TTL 5 минут) ----------
const KEY = 'di:calc';
const TTL = 5 * 60_000;

function saveState() {
  try {
    const state = {
      dist: distEl.value,
      speed: speedEl.value,
      p9: p9Count,
      pauses: pauseEls.map((el) => el.checked),
      extraH: ehEl.value,
      extraM: emEl.value,
      fuelOn: fuelOn.checked,
      truck: truckEl.value,
      trailer: trailerEl.value,
      idle: idleEl.value,
      tab: panelTanks.hidden ? 'trip' : 'tanks',
      brand: currentBrand(),
      tanks: tankCm,
      t: Date.now(),
    };
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* приватный режим — не критично */
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s.t || Date.now() - s.t >= TTL) return null; // просрочено — начинаем заново
    return s;
  } catch {
    return null;
  }
}

function clearState() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* не критично */
  }
}

// ---------- Расчёт ----------

// Число из поля: пустое/мусор -> 0, отрицательные отсекаем.
function num(el) {
  const v = parseFloat(String(el.value).replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function fmtHHMM(totalMin) {
  const m = Math.round(totalMin);
  const h = Math.floor(m / 60); // часы без ограничения 24 (пауза 45ч даёт больше суток)
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function fmtL(liters) {
  return liters.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' л';
}

function arrivalText(totalMin) {
  const now = new Date();
  const eta = new Date(now.getTime() + totalMin * 60_000);
  const time = eta.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const etaDay = new Date(eta.getFullYear(), eta.getMonth(), eta.getDate());
  const days = Math.round((etaDay - startDay) / 86_400_000);

  let when = '';
  if (days === 0) when = 'сегодня';
  else if (days === 1) when = 'завтра';
  else when = eta.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

  return `Прибытие ~ ${when} ${time}`;
}

function calc() {
  const dist = num(distEl);
  const speed = num(speedEl);

  // Паузы: девятки из степпера + отмеченные чек-боксы + своя пауза (часы/минуты).
  const pauseHours = 9 * p9Count
    + pauseEls.reduce((sum, el) => sum + (el.checked ? Number(el.value) : 0), 0);
  const extraH = num(ehEl);
  const extraMin = Math.min(59, num(emEl)); // минуты клампим в 0–59
  const pauseMin = pauseHours * 60 + extraH * 60 + extraMin;

  if (!dist || !speed) {
    timeEl.textContent = '—:—';
    arrivalEl.textContent = '';
    breakdownEl.textContent = pauseMin
      ? `Паузы ${fmtHHMM(pauseMin)} · введите расстояние и скорость`
      : 'Введите расстояние и скорость';
    updateFuel(dist, 0, false); // время невалидно — топливо не считаем
    return;
  }

  const driveMin = (dist / speed) * 60;
  const totalMin = driveMin + pauseMin;

  timeEl.textContent = fmtHHMM(totalMin);
  arrivalEl.textContent = arrivalText(totalMin);
  breakdownEl.textContent = pauseMin
    ? `Движение ${fmtHHMM(driveMin)} + паузы ${fmtHHMM(pauseMin)}`
    : `Движение ${fmtHHMM(driveMin)}`;

  updateFuel(dist, totalMin, true);
}

// Топливо считаем, только когда включена галочка. Тягач — километраж + двигатель
// на стоянке (часы × IDLE_LPH), прицеп — полное время в пути (тот же totalMin, что и большая цифра).
function updateFuel(dist, totalMin, timeValid) {
  fuelBlock.hidden = !fuelOn.checked;
  if (!fuelOn.checked) return;

  const idleH = num(idleEl);
  const idleL = idleH * IDLE_LPH;
  fuelIdleRow.hidden = !idleH; // строка стоянки видна, только если часы > 0

  if (!timeValid) {
    fuelTruckEl.textContent = '— л';
    fuelIdleEl.textContent = '— л';
    fuelTruckTotalEl.textContent = '— л';
    fuelTrailerEl.textContent = '— л';
    return;
  }

  const truckL = (dist / 100) * num(truckEl);
  const trailerL = (totalMin / 60) * num(trailerEl);
  fuelTruckEl.textContent = fmtL(truckL);
  fuelIdleEl.textContent = fmtL(idleL);
  fuelTruckTotalEl.textContent = fmtL(truckL + idleL);
  fuelTrailerEl.textContent = fmtL(trailerL);
}

// ---------- Степпер «Пауза 9 ч» ----------

function setP9(n) {
  p9Count = Math.max(0, Math.min(P9_MAX, n));
  const on = p9Count > 0;
  p9Chip.classList.toggle('is-on', on);
  p9Minus.hidden = !on;
  p9Plus.hidden = !on;
  p9X.hidden = !on;
  p9X.textContent = on ? `×${p9Count}` : '';
  p9Plus.disabled = p9Count >= P9_MAX;
}

// ---------- Баки ----------

// Подписи и памятка под выбранную марку: ёмкость в названии бака, отметка линейки.
function updateTankInfo() {
  const b = TANKS[currentBrand()];
  tank1LabelEl.textContent = `Бак 1 (${b.tanks[0].cap} л), см`;
  tank2LabelEl.textContent = `Бак 2 (${b.tanks[1].cap} л), см`;
  tank1NameEl.textContent = `Бак 1 (${b.tanks[0].cap} л)`;
  tank2NameEl.textContent = `Бак 2 (${b.tanks[1].cap} л)`;
  tankNoteEl.textContent = b.note;
}

// Расчёт остатка: литры = см × л/см. Пустое поле -> «— л».
function calcTanks() {
  const tanks = TANKS[currentBrand()].tanks;
  const cms = [num(tank1El), num(tank2El)];
  const outs = [tank1LEl, tank2LEl];

  let total = 0;
  let anyKnown = false;
  cms.forEach((cm, i) => {
    if (cm) {
      const liters = cm * tanks[i].lPerCm;
      outs[i].textContent = fmtL(liters);
      total += liters;
      anyKnown = true;
    } else {
      outs[i].textContent = '— л';
    }
  });
  tanksTotalEl.textContent = anyKnown ? fmtL(total) : '— л';
}

// Смена марки: запоминаем сантиметры прежней марки, показываем сантиметры новой.
let shownBrand = 'man';

function switchBrand() {
  tankCm[shownBrand] = [tank1El.value, tank2El.value];
  shownBrand = currentBrand();
  [tank1El.value, tank2El.value] = tankCm[shownBrand];
  updateTankInfo();
  calcTanks();
}

// ---------- Вкладки ----------

function setTab(name) {
  const tanks = name === 'tanks';
  tabTrip.classList.toggle('is-active', !tanks);
  tabTanks.classList.toggle('is-active', tanks);
  tabTrip.setAttribute('aria-selected', String(!tanks));
  tabTanks.setAttribute('aria-selected', String(tanks));
  panelTrip.hidden = tanks;
  panelTanks.hidden = !tanks;
}

// ---------- Пересчёт + сохранение на каждое изменение ----------

function onInput() {
  calc();
  saveState();
}

function onTankInput() {
  tankCm[shownBrand] = [tank1El.value, tank2El.value];
  calcTanks();
  saveState();
}

// ---------- Открытие / закрытие ----------

function applyState(s) {
  distEl.value = s?.dist ?? '';
  speedEl.value = s?.speed ?? '';
  setP9(Number(s?.p9) || 0);
  pauseEls.forEach((el, i) => { el.checked = Boolean(s?.pauses?.[i]); });
  ehEl.value = s?.extraH ?? '';
  emEl.value = s?.extraM ?? '';
  fuelOn.checked = Boolean(s?.fuelOn);
  truckEl.value = s?.truck ?? '';
  trailerEl.value = s?.trailer ?? '';
  idleEl.value = s?.idle ?? '';

  // Баки: сантиметры по маркам + выбранная марка.
  const brands = ['man', 'daf', 'volvo'];
  tankCm = Object.fromEntries(brands.map((b) => {
    const pair = s?.tanks?.[b];
    return [b, [pair?.[0] ?? '', pair?.[1] ?? '']];
  }));
  shownBrand = brands.includes(s?.brand) ? s.brand : 'man';
  brandEls.forEach((el) => { el.checked = el.value === shownBrand; });
  [tank1El.value, tank2El.value] = tankCm[shownBrand];
  updateTankInfo();

  setTab(s?.tab === 'tanks' ? 'tanks' : 'trip');
}

function open() {
  if (!modal.hidden) return;
  const saved = loadState();
  if (saved) applyState(saved);
  else setDefaults();
  calc();
  calcTanks();

  modal.hidden = false;
  document.body.classList.add('is-locked');
  // setTimeout, а не rAF — rAF не срабатывает в фоновой вкладке (как в модалке просмотра).
  modal.classList.add('is-opening');
  setTimeout(() => modal.classList.remove('is-opening'), 20);
}

let closeTimer = null;

function close() {
  if (modal.hidden) return;
  document.body.classList.remove('is-locked');
  modal.classList.add('is-closing');
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    modal.hidden = true;
    modal.classList.remove('is-closing');
  }, 240);
}

// Значения по умолчанию: скорость 70, расходы 27 / 1,8, топливо включено, паузы сняты,
// баки пустые, марка MAN, вкладка «Время и топливо».
function setDefaults() {
  applyState(null);
  speedEl.value = DEFAULT_SPEED;
  truckEl.value = DEFAULT_TRUCK;
  trailerEl.value = DEFAULT_TRAILER;
  fuelOn.checked = true; // топливо считаем сразу
}

// Сбрасывает обе вкладки, активную не переключает.
function reset() {
  const wasTanks = !panelTanks.hidden;
  setDefaults();
  setTab(wasTanks ? 'tanks' : 'trip');
  clearState();
  calc();
  calcTanks();
  saveState();
}

// ---------- События ----------

fab.addEventListener('click', open);
closeBtn.addEventListener('click', close);
doneBtn.addEventListener('click', close);
backdrop.addEventListener('click', close);
resetBtn.addEventListener('click', reset);

tabTrip.addEventListener('click', () => { setTab('trip'); saveState(); });
tabTanks.addEventListener('click', () => { setTab('tanks'); saveState(); });

// Степпер девяток: тап по надписи тоже +1 (крупная цель), минус до нуля выключает.
p9Main.addEventListener('click', () => { setP9(p9Count + 1); onInput(); });
p9Plus.addEventListener('click', () => { setP9(p9Count + 1); onInput(); });
p9Minus.addEventListener('click', () => { setP9(p9Count - 1); onInput(); });

[distEl, speedEl, ehEl, emEl, fuelOn, truckEl, trailerEl, idleEl, ...pauseEls].forEach((el) => {
  el.addEventListener('input', onInput);
  el.addEventListener('change', onInput);
});

[tank1El, tank2El].forEach((el) => {
  el.addEventListener('input', onTankInput);
  el.addEventListener('change', onTankInput);
});

brandEls.forEach((el) => {
  el.addEventListener('change', () => { switchBrand(); saveState(); });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) close();
});

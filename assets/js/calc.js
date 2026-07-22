// Калькулятор времени до точки: расстояние + скорость + паузы -> ЧЧ:ММ и время прибытия.
// Самодостаточный модуль: открывается плавающей кнопкой, не трогает hash-роутинг app.js.

const fab = document.getElementById('calc-fab');
const modal = document.getElementById('calc');
const backdrop = document.getElementById('calc-backdrop');
const closeBtn = document.getElementById('calc-close');
const doneBtn = document.getElementById('calc-done');
const resetBtn = document.getElementById('calc-reset');

const distEl = document.getElementById('calc-dist');
const speedEl = document.getElementById('calc-speed');
const ehEl = document.getElementById('calc-eh');
const emEl = document.getElementById('calc-em');
const pauseEls = ['calc-p9', 'calc-p24', 'calc-p45', 'calc-p2'].map((id) => document.getElementById(id));

const timeEl = document.getElementById('calc-time');
const arrivalEl = document.getElementById('calc-arrival');
const breakdownEl = document.getElementById('calc-breakdown');

// Топливо (опционально, по галочке)
const fuelOn = document.getElementById('calc-fuel-on');
const fuelBlock = document.getElementById('calc-fuel');
const truckEl = document.getElementById('calc-truck');
const trailerEl = document.getElementById('calc-trailer');
const fuelTruckEl = document.getElementById('calc-fuel-truck');
const fuelTrailerEl = document.getElementById('calc-fuel-trailer');
const fuelTotalEl = document.getElementById('calc-fuel-total');

const DEFAULT_SPEED = 70;
const DEFAULT_TRUCK = 27;    // л/100 км
const DEFAULT_TRAILER = 1.8; // л/ч (холодильная установка)

// ---------- Хранилище (ключ отдельный от «недавних»; TTL 5 минут) ----------
const KEY = 'di:calc';
const TTL = 5 * 60_000;

function saveState() {
  try {
    const state = {
      dist: distEl.value,
      speed: speedEl.value,
      pauses: pauseEls.map((el) => el.checked),
      extraH: ehEl.value,
      extraM: emEl.value,
      fuelOn: fuelOn.checked,
      truck: truckEl.value,
      trailer: trailerEl.value,
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
  return liters.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' л';
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

  // Паузы: сумма отмеченных чек-боксов + своя пауза (часы/минуты).
  const pauseHours = pauseEls.reduce((sum, el) => sum + (el.checked ? Number(el.value) : 0), 0);
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

// Топливо считаем, только когда включена галочка. Тягач — от километража,
// прицеп — от полного времени в пути (тот же totalMin, что и большая цифра).
function updateFuel(dist, totalMin, timeValid) {
  fuelBlock.hidden = !fuelOn.checked;
  if (!fuelOn.checked) return;

  if (!timeValid) {
    fuelTruckEl.textContent = '— л';
    fuelTrailerEl.textContent = '— л';
    fuelTotalEl.textContent = '— л';
    return;
  }

  const truckL = (dist / 100) * num(truckEl);
  const trailerL = (totalMin / 60) * num(trailerEl);
  fuelTruckEl.textContent = fmtL(truckL);
  fuelTrailerEl.textContent = fmtL(trailerL);
  fuelTotalEl.textContent = fmtL(truckL + trailerL);
}

// Пересчёт + сохранение на каждое изменение.
function onInput() {
  calc();
  saveState();
}

// ---------- Открытие / закрытие ----------

function applyState(s) {
  distEl.value = s?.dist ?? '';
  speedEl.value = s?.speed ?? '';
  pauseEls.forEach((el, i) => { el.checked = Boolean(s?.pauses?.[i]); });
  ehEl.value = s?.extraH ?? '';
  emEl.value = s?.extraM ?? '';
  fuelOn.checked = Boolean(s?.fuelOn);
  truckEl.value = s?.truck ?? '';
  trailerEl.value = s?.trailer ?? '';
}

function open() {
  if (!modal.hidden) return;
  const saved = loadState();
  if (saved) applyState(saved);
  else setDefaults();
  calc();

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

// Значения по умолчанию: скорость 70, расходы 27 / 1,8, топливо включено, паузы сняты.
function setDefaults() {
  applyState(null);
  speedEl.value = DEFAULT_SPEED;
  truckEl.value = DEFAULT_TRUCK;
  trailerEl.value = DEFAULT_TRAILER;
  fuelOn.checked = true; // топливо считаем сразу
}

function reset() {
  setDefaults();
  clearState();
  calc();
  saveState();
}

// ---------- События ----------

fab.addEventListener('click', open);
closeBtn.addEventListener('click', close);
doneBtn.addEventListener('click', close);
backdrop.addEventListener('click', close);
resetBtn.addEventListener('click', reset);

[distEl, speedEl, ehEl, emEl, fuelOn, truckEl, trailerEl, ...pauseEls].forEach((el) => {
  el.addEventListener('input', onInput);
  el.addEventListener('change', onInput);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) close();
});

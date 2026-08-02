// Гид по инструктажу: пошаговый разбор базы знаний для новых водителей.
// Самодостаточный модуль: не импортирует и не экспортирует ничего в app.js,
// но участвует в hash-роутинге как собственный «виртуальный экран» (#/guide/...),
// потому что, в отличие от калькулятора, должен уметь передавать управление
// на настоящую карточку (viewer) и возвращаться назад на тот же шаг.

import { typeMeta } from './drive.js?v=5';

const KEY = 'di:guide'; // без TTL — водитель может вернуться через неделю

const banner = document.getElementById('guide-banner');
const bannerSub = document.getElementById('guide-banner-sub');
const bannerBar = document.getElementById('guide-banner-bar');
const bannerFill = document.getElementById('guide-banner-fill');

const guideEl = document.getElementById('guide');
const guideClose = document.getElementById('guide-close');
const guideHome = document.getElementById('guide-home');
const guideBlockTitle = document.getElementById('guide-block-title');
const chipsEl = document.getElementById('guide-chips');
const progressText = document.getElementById('guide-progress-text');
const progressFill = document.getElementById('guide-progress-fill');
const bodyEl = document.getElementById('guide-body');
const backBtn = document.getElementById('guide-back');
const nextBtn = document.getElementById('guide-next');
const resetLink = document.getElementById('guide-reset-link');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

let data = null;      // guide.json
let itemsById = null; // instructions.json items -> Map по id, для заголовков/иконок ссылок
let steps = [];       // плоский список { ...step, blockId, blockTitle }
let currentId = null;

// ---------- localStorage ----------

function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveState(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* приватный режим / диск полон — не критично, гид работает в рамках сессии */
  }
}

function getProgress() {
  return loadState() || { current: null, done: {} };
}

function markDone(stepId) {
  const s = getProgress();
  s.done[stepId] = true;
  s.current = stepId;
  saveState(s);
}

// Снятая галочка обязана стирать отметку о прохождении: иначе водитель мог бы
// поставить её, вернуться назад, снять — а шаг остался бы зачтённым.
function unmarkDone(stepId) {
  const s = getProgress();
  delete s.done[stepId];
  s.current = stepId;
  saveState(s);
}

function setCurrent(stepId) {
  const s = getProgress();
  s.current = stepId;
  saveState(s);
}

function resetProgress() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* не критично */
  }
}

// ---------- Хеш (своя копия парсера app.js — не импортируется, т.к. route() там не экспортирована) ----------

function parseHash() {
  const hash = location.hash.slice(2); // убираем "#/"
  const [screen, id] = hash.split('/');
  return { screen: screen || 'home', id: id ? decodeURIComponent(id) : null };
}

// ---------- Данные ----------

async function ensureData() {
  if (data) return true;
  try {
    const [guideRes, instrRes] = await Promise.all([
      fetch(`data/guide.json?v=${Date.now()}`, { cache: 'no-cache' }),
      fetch(`data/instructions.json?v=${Date.now()}`, { cache: 'no-cache' }),
    ]);
    if (!guideRes.ok || !instrRes.ok) throw new Error('fetch failed');
    data = await guideRes.json();
    const instr = await instrRes.json();
    itemsById = new Map(instr.items.map((i) => [i.id, i]));

    steps = [];
    for (const block of data.blocks) {
      for (const step of block.steps) {
        steps.push({ ...step, blockId: block.id, blockTitle: block.title, blockIcon: block.icon });
      }
    }
    return true;
  } catch (err) {
    console.error('Гид: не удалось загрузить данные', err);
    return false;
  }
}

// ---------- Баннер на главном экране ----------

async function paintBanner() {
  const ok = await ensureData();
  if (!ok || !steps.length) {
    banner.hidden = true;
    return;
  }
  const progress = getProgress();
  const doneCount = Object.keys(progress.done).length;

  if (doneCount === 0) {
    bannerSub.textContent = data.subtitle;
    bannerBar.hidden = true;
  } else if (doneCount >= steps.length) {
    bannerSub.textContent = 'Пройдено полностью — можно повторить';
    bannerBar.hidden = true;
  } else {
    bannerSub.textContent = `Продолжить: шаг ${doneCount} из ${steps.length}`;
    bannerBar.hidden = false;
    bannerFill.style.width = `${Math.round((doneCount / steps.length) * 100)}%`;
  }
}

function targetStepId() {
  const progress = getProgress();
  if (progress.current && steps.some((s) => s.id === progress.current)) return progress.current;
  return steps[0]?.id ?? null;
}

banner.addEventListener('click', (e) => {
  e.preventDefault();
  const id = targetStepId();
  if (id) location.hash = `#/guide/${encodeURIComponent(id)}`;
});

// ---------- Рендер экрана гида ----------

function findStep(id) {
  return steps.find((s) => s.id === id) || null;
}

function renderChips(activeBlockId) {
  const blocks = data.blocks;
  chipsEl.innerHTML = blocks
    .map(
      (b) => `
      <button type="button" class="guide__chip${b.id === activeBlockId ? ' is-active' : ''}" data-block="${esc(b.id)}">
        <span aria-hidden="true">${esc(b.icon || '')}</span> ${esc(b.title)}
      </button>`
    )
    .join('');
  scrollActiveChipIntoView();
}

// Лента блоков вверху шире экрана, поэтому активный блок нужно подвозить к
// водителю самим — иначе на шаге из середины гида подсвеченный блок остаётся
// за правым краем и кажется, что заголовок не совпадает с вопросом.
// Скроллим саму ленту (scrollLeft), а не scrollIntoView(): последний утянул бы
// за собой и вертикальный скролл страницы.
function scrollActiveChipIntoView() {
  const active = chipsEl.querySelector('.guide__chip.is-active');
  if (!active) return;
  const target = active.offsetLeft - (chipsEl.clientWidth - active.offsetWidth) / 2;
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  chipsEl.scrollTo({ left: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
}

function itemLinkHTML(itemId) {
  const item = itemsById.get(itemId);
  if (!item) {
    return `<span class="guide-link guide-link--broken">Материал недоступен</span>`;
  }
  const t = typeMeta(item.type);
  return `
    <a class="guide-link" href="#/item/${encodeURIComponent(item.id)}">
      <span class="guide-link__badge" style="--t: var(--t-${esc(item.type)})" aria-hidden="true">${t.icon}</span>
      <span class="guide-link__title">${esc(item.title)}</span>
      <svg class="guide-link__chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    </a>`;
}

function renderStep(step) {
  const idx = steps.indexOf(step);
  const progress = getProgress();
  const checked = !!progress.done[step.id];

  guideBlockTitle.textContent = step.blockTitle;
  renderChips(step.blockId);

  progressText.textContent = `Шаг ${idx + 1} из ${steps.length}`;
  progressFill.style.width = `${Math.round(((idx + 1) / steps.length) * 100)}%`;

  const paras = step.text.map((p) => `<p>${esc(p)}</p>`).join('');
  const links = (step.items || []).map(itemLinkHTML).join('');

  const confirmHTML = step.confirm
    ? `
      <label class="guide-check">
        <input type="checkbox" id="guide-confirm-box" ${checked ? 'checked' : ''}>
        <span>${esc(step.confirm)}</span>
      </label>`
    : '';

  bodyEl.innerHTML = `
    <h2 class="guide__step-title">${esc(step.title)}</h2>
    <div class="guide__step-text">${paras}</div>
    ${links ? `<div class="guide__links">${links}</div>` : ''}
    ${confirmHTML}
  `;

  const box = document.getElementById('guide-confirm-box');
  if (box) {
    box.addEventListener('change', () => {
      if (box.checked) markDone(step.id);
      else unmarkDone(step.id);
      syncNextBtn(step);
    });
  }

  backBtn.disabled = idx === 0;
  const isLast = idx === steps.length - 1;
  nextBtn.textContent = isLast ? 'Готово ✓' : 'Далее →';
  syncNextBtn(step);
}

// Пока водитель сам не поставил галочку, «Далее» заблокирована — шаг нельзя
// проскочить не прочитав. Раньше goDelta() отмечал шаг пройденным самим фактом
// нажатия «Далее», из-за чего при возврате галочка оказывалась уже проставленной,
// хотя водитель её не трогал. У шагов без confirm (если появятся) блокировки нет.
function syncNextBtn(step) {
  const needsConfirm = !!step.confirm;
  const done = !!getProgress().done[step.id];
  nextBtn.disabled = needsConfirm && !done;
  nextBtn.setAttribute('aria-disabled', String(nextBtn.disabled));
  nextBtn.title = nextBtn.disabled ? 'Сначала отметьте галочку под текстом' : '';
}

function goToStep(id, { push = false } = {}) {
  const step = findStep(id);
  if (!step) return;
  currentId = id;
  setCurrent(id);
  renderStep(step);
  bodyEl.scrollTop = 0;
  if (push) location.hash = `#/guide/${encodeURIComponent(id)}`;
  else history.replaceState(null, '', `#/guide/${encodeURIComponent(id)}`);
}

function goDelta(delta) {
  const idx = steps.findIndex((s) => s.id === currentId);
  if (idx < 0) return;
  // Вперёд можно только с отмеченной галочкой — см. syncNextBtn(). Проверка
  // продублирована здесь, т.к. вперёд ведёт не только кнопка (клавиатура, код).
  if (delta > 0 && steps[idx].confirm && !getProgress().done[steps[idx].id]) return;

  const next = steps[idx + delta];
  if (!next) {
    // «Готово» на последнем шаге — не закрываем гид, а ведём в регистрацию
    // (register.js), она сама скроет гид и покажет себя через #/register.
    if (delta > 0) location.hash = '#/register';
    return;
  }
  goToStep(next.id);
}

chipsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.guide__chip');
  if (!btn) return;
  const block = data.blocks.find((b) => b.id === btn.dataset.block);
  if (block?.steps[0]) goToStep(block.steps[0].id);
});

backBtn.addEventListener('click', () => goDelta(-1));
nextBtn.addEventListener('click', () => goDelta(1));

resetLink.addEventListener('click', (e) => {
  e.preventDefault();
  if (!confirm('Сбросить прогресс прохождения гида?')) return;
  resetProgress();
  paintBanner();
  const first = steps[0];
  if (first) goToStep(first.id);
});

function closeGuide() {
  history.back();
}
guideClose.addEventListener('click', closeGuide);
guideHome.addEventListener('click', () => { location.hash = ''; });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !guideEl.hidden) closeGuide();
});

// ---------- Показ / скрытие, синхронизация с хешем ----------

let closeTimer = null;

function showGuide(id) {
  const target = id && findStep(id) ? id : targetStepId();
  if (!target) return;
  currentId = target;
  renderStep(findStep(target));

  clearTimeout(closeTimer);
  guideEl.classList.remove('is-closing');
  guideEl.hidden = false;
  document.body.classList.add('is-locked');

  // calc-fab визуально перекрыт (z-index 45 > 40), но hidden у него не стоит —
  // без этого он остаётся в tab-order и ловит фокус с клавиатуры позади гида.
  const fab = document.getElementById('calc-fab');
  if (fab) fab.hidden = true;

  // setTimeout, а не rAF — та же причина, что и в viewer/calc: rAF не срабатывает
  // в фоновой вкладке (телефон может быть заблокирован во время инструктажа).
  guideEl.classList.add('is-opening');
  setTimeout(() => guideEl.classList.remove('is-opening'), 20);
}

function hideGuide() {
  const fab = document.getElementById('calc-fab');
  if (fab) fab.hidden = false;

  if (guideEl.hidden || guideEl.classList.contains('is-closing')) return;

  // Не снимать is-locked безусловно: если прячемся из-за открытой карточки
  // (viewer), блокировку скролла только что поставил сам viewer — трогать нельзя.
  const viewer = document.getElementById('viewer');
  if (!viewer || viewer.hidden) document.body.classList.remove('is-locked');

  guideEl.classList.add('is-closing');
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    guideEl.hidden = true;
    guideEl.classList.remove('is-closing');
  }, 220);
}

async function syncFromHash() {
  const { screen, id } = parseHash();
  if (screen !== 'guide') {
    hideGuide();
    return;
  }
  const ok = await ensureData();
  if (!ok) return;
  showGuide(id);
}

window.addEventListener('hashchange', syncFromHash);

// ---------- Старт ----------

paintBanner();
syncFromHash(); // прямой заход по ссылке на шаг — не только по событию hashchange

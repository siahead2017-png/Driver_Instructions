// ?v=... держим синхронно с index.html — иначе браузер закеширует старую версию модуля.
import { toEmbedUrl, typeMeta } from './drive.js?v=5';
import { getRecent, pushRecent, nextRecentExpiry } from './store.js?v=5';

const view = document.getElementById('view');
const headerTitle = document.getElementById('header-title');
const backBtn = document.getElementById('back-btn');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const footerMeta = document.getElementById('footer-meta');
const viewer = document.getElementById('viewer');
const viewerBody = document.getElementById('viewer-body');
const viewerTitle = document.getElementById('viewer-title');
const viewerOpen = document.getElementById('viewer-open');
const viewerClose = document.getElementById('viewer-close');

let data = { categories: [], items: [] };
let query = '';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const byId = (id) => data.items.find((i) => i.id === id);
const catById = (id) => data.categories.find((c) => c.id === id);
const itemsOf = (catId) => data.items.filter((i) => i.category === catId);

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------- Загрузка ----------

function renderSkeleton() {
  const cells = Array.from({ length: 8 }, () => '<div class="skeleton"></div>').join('');
  view.innerHTML = `
    <section class="section">
      <h2 class="section__title">Категории</h2>
      <div class="skeleton-tiles">${cells}</div>
    </section>`;
}

async function load() {
  renderSkeleton();
  try {
    const res = await fetch('data/instructions.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    data.categories.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    const n = data.items.length;
    const count = `${n} ${plural(n, 'инструкция', 'инструкции', 'инструкций')}`;
    footerMeta.textContent = data.updated
      ? `Обновлено ${fmtDate(data.updated)} · ${count}`
      : count;
    render();
  } catch (err) {
    view.innerHTML = `
      <div class="empty">
        <div class="empty__icon">⚠️</div>
        <p class="empty__title">Не удалось загрузить список</p>
        <p class="empty__text">${esc(err.message)}</p>
      </div>`;
  }
}

// ---------- Роутинг ----------

function route() {
  const hash = location.hash.slice(2); // убираем "#/"
  const [screen, id] = hash.split('/');
  return { screen: screen || 'home', id: id ? decodeURIComponent(id) : null };
}

window.addEventListener('hashchange', render);

// ---------- Рендер ----------

function render() {
  const { screen, id } = route();

  if (query.trim()) {
    renderSearch();
    return;
  }

  if (screen === 'category' && catById(id)) {
    renderCategory(catById(id));
  } else {
    renderHome();
  }

  // Модалка просмотра управляется хешем — работает кнопка «Назад» на телефоне.
  if (screen === 'item' && byId(id)) openViewer(byId(id));
  else closeViewer();
}

function setHeader(title, showBack) {
  headerTitle.textContent = title;
  backBtn.hidden = !showBack;
}

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Заменяем содержимое #view и перезапускаем анимацию появления экрана.
// entrance: 'is-entering' (обычный fade) или 'is-flip-in' (влёт из переворота).
function setView(html, entrance = 'is-entering') {
  view.innerHTML = html;
  view.classList.remove('is-entering', 'is-flip-in');
  void view.offsetWidth; // форсируем reflow, чтобы анимация проиграла заново
  view.classList.add(entrance);
}

// Флаг: следующий экран категории показать анимацией переворота.
let flipNext = false;

// Клик по плитке: сначала «переворот» плитки, затем переход в категорию.
view.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || !view.contains(tile) || prefersReducedMotion()) return; // иначе обычный переход
  const href = tile.getAttribute('href');
  if (!href) return;
  e.preventDefault();
  flipNext = true;
  tile.classList.add('is-flipping');
  const go = () => { location.hash = href.slice(1); };
  tile.addEventListener('animationend', go, { once: true });
  setTimeout(go, 450); // страховка, если animationend не придёт
});

function cardHTML(item, i = 0) {
  const t = typeMeta(item.type);
  const importantClass = item.important ? ' card--important' : '';
  // type "link" — не Диск, а внешний сайт/приложение: открываем сразу в новой вкладке,
  // а не через внутренний просмотрщик (там нечего встраивать).
  const external = item.type === 'link';
  const href = external ? esc(item.url) : `#/item/${encodeURIComponent(item.id)}`;
  const extraAttrs = external ? ' target="_blank" rel="noopener"' : '';
  const badge = item.image
    ? `<img class="card__badge card__badge--custom" src="${esc(item.image)}" alt="" aria-hidden="true">`
    : `<span class="card__badge card__badge--${esc(item.type)}" aria-hidden="true">${t.icon}</span>`;
  return `
    <a class="card${importantClass}" style="--i:${i}" href="${href}"${extraAttrs}>
      ${badge}
      <span class="card__body">
        <span class="card__title">${esc(item.title)}</span>
        ${item.description ? `<span class="card__desc">${esc(item.description)}</span>` : ''}
        <span class="card__meta">${esc(t.label)}${item.updated ? ` · ${fmtDate(item.updated)}` : ''}</span>
      </span>
      <svg class="card__chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>
    </a>`;
}

let recentTimer = null;

function renderHome() {
  setHeader('Инструкции', false);

  // Ссылки на другие приложения компании (Заправки, fotohd.lv) — сверху главной,
  // чтобы их было видно сразу и не искали по памяти. Список — data.apps.
  // Рендерятся через cardHTML() — та же карточка, что и везде в каталоге (type: "link" уже умеет открывать в новой вкладке).
  const apps = data.apps ?? [];
  const appsHTML = apps.length
    ? `<section class="section section--apps">
         <div class="list">${apps.map((a, i) => cardHTML(a, i)).join('')}</div>
       </section>`
    : '';

  // Важные инструкции — всегда первым блоком, чтобы не потерялись внутри категорий.
  const important = data.items.filter((it) => it.important);
  const importantHTML = important.length
    ? `<section class="section section--important">
         <h2 class="section__title">❗ Важно</h2>
         <div class="list">${important.map((it, i) => cardHTML(it, i)).join('')}</div>
       </section>`
    : '';

  const recent = getRecent().map(byId).filter(Boolean);

  // Через минуту «Недавние» устаревают — перерисуем главную, чтобы блок исчез,
  // даже если пользователь всё это время смотрит на неё.
  clearTimeout(recentTimer);
  const expiry = nextRecentExpiry();
  if (expiry) {
    recentTimer = setTimeout(() => {
      if (!query.trim() && route().screen === 'home') renderHome();
    }, Math.max(0, expiry - Date.now()) + 50);
  }
  const recentHTML = recent.length
    ? `<section class="section">
         <h2 class="section__title">Недавние</h2>
         <div class="list">${recent.map((it, i) => cardHTML(it, i)).join('')}</div>
       </section>`
    : '';

  const tiles = data.categories
    .map((c, i) => {
      const n = itemsOf(c.id).length;
      return `
        <a class="tile" style="--i:${i}" href="#/category/${encodeURIComponent(c.id)}">
          <span class="tile__icon" aria-hidden="true">${esc(c.icon ?? '📁')}</span>
          <span class="tile__title">${esc(c.title)}</span>
          <span class="tile__count">${n} ${plural(n, 'инструкция', 'инструкции', 'инструкций')}</span>
        </a>`;
    })
    .join('');

  setView(`
    ${appsHTML}
    ${importantHTML}
    ${recentHTML}
    <section class="section">
      <h2 class="section__title">Категории</h2>
      <div class="tiles">${tiles}</div>
    </section>`);
}

function renderCategory(cat) {
  setHeader(cat.title, true);

  // Вход переворотом — только если попали сюда кликом по плитке.
  const entrance = flipNext ? 'is-flip-in' : 'is-entering';
  flipNext = false;

  const items = itemsOf(cat.id);
  if (!items.length) {
    setView(`<div class="empty"><div class="empty__icon">📭</div>
      <p class="empty__title">Пока пусто</p>
      <p class="empty__text">В этой категории ещё нет инструкций.</p></div>`, entrance);
    return;
  }

  // Группируем по подтеме; элементы без подтемы идут первыми, одной группой.
  const groups = new Map([['', []]]);
  for (const it of items) {
    const key = it.subtopic ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  if (!groups.get('').length) groups.delete('');

  // Порядок групп задаётся необязательным списком categories[].subtopics.
  // Подтемы, которых там нет, идут следом в порядке появления.
  const order = cat.subtopics ?? [];
  const rank = (sub) => {
    if (sub === '') return -1; // карточки без подтемы — всегда сверху
    const i = order.indexOf(sub);
    return i === -1 ? order.length : i;
  };
  const sorted = [...groups].sort((a, b) => rank(a[0]) - rank(b[0]));

  let idx = 0; // сквозной индекс для ступенчатого появления через все группы
  setView(sorted
    .map(([sub, list]) => `
      <section class="section">
        ${sub ? `<h2 class="section__title">${esc(sub)}</h2>` : ''}
        <div class="list">${list.map((it) => cardHTML(it, idx++)).join('')}</div>
      </section>`)
    .join(''), entrance);
}

function renderSearch() {
  setHeader('Поиск', false);
  const q = query.trim().toLowerCase();
  const hits = data.items.filter((i) =>
    [i.title, i.description, ...(i.tags ?? [])].join(' ').toLowerCase().includes(q));

  setView(hits.length
    ? `<section class="section">
         <h2 class="section__title">Найдено: ${hits.length}</h2>
         <div class="list">${hits.map((it, i) => cardHTML(it, i)).join('')}</div>
       </section>`
    : `<div class="empty"><div class="empty__icon">🔍</div>
         <p class="empty__title">Ничего не найдено</p>
         <p class="empty__text">Попробуй другое слово.</p></div>`);
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---------- Просмотр ----------

let viewerOpenId = null;

function openViewer(item) {
  if (viewerOpenId === item.id) return;
  viewerOpenId = item.id;
  pushRecent(item.id);

  viewerTitle.textContent = item.title;
  viewerOpen.href = item.url;
  viewer.hidden = false;
  document.body.classList.add('is-locked');

  // Анимация появления: стартуем из смещённого/прозрачного состояния и снимаем его.
  // setTimeout, а не requestAnimationFrame — rAF не срабатывает в фоновой вкладке.
  clearTimeout(closeTimer);
  clearTimeout(openTimer);
  viewer.classList.remove('is-closing');
  viewer.classList.add('is-opening');
  openTimer = setTimeout(() => viewer.classList.remove('is-opening'), 20);

  const embed = toEmbedUrl(item);
  if (!embed) {
    viewerBody.innerHTML = fallbackHTML(item, 'Этот файл нельзя показать встроенно.');
    return;
  }

  viewerBody.innerHTML = `
    <div class="viewer__loading" id="viewer-loading"><span class="spinner"></span>Загрузка…</div>
    <iframe class="viewer__frame" id="viewer-frame" src="${esc(embed)}"
      allow="autoplay; fullscreen" allowfullscreen referrerpolicy="no-referrer"></iframe>`;

  const frame = document.getElementById('viewer-frame');
  const loading = document.getElementById('viewer-loading');
  frame.addEventListener('load', () => loading?.remove(), { once: true });

  // Если за 8 секунд ничего не появилось — вероятно, закрыт доступ к файлу.
  setTimeout(() => {
    if (viewerOpenId === item.id && document.getElementById('viewer-loading')) {
      viewerBody.innerHTML = fallbackHTML(
        item,
        'Файл долго не открывается. Возможно, к нему закрыт доступ по ссылке.');
    }
  }, 8000);
}

function fallbackHTML(item, reason) {
  return `
    <div class="empty">
      <div class="empty__icon">🔗</div>
      <p class="empty__title">${esc(reason)}</p>
      <a class="btn" href="${esc(item.url)}" target="_blank" rel="noopener">Открыть на Google Диске</a>
    </div>`;
}

let closeTimer = null;
let openTimer = null;

function closeViewer() {
  if (viewer.hidden || viewer.classList.contains('is-closing')) return;
  viewerOpenId = null;
  viewerBody.innerHTML = ''; // выгружаем iframe сразу, иначе видео продолжает играть
  document.body.classList.remove('is-locked');

  // Анимация выезда, затем прячем контейнер.
  viewer.classList.add('is-closing');
  closeTimer = setTimeout(() => {
    viewer.hidden = true;
    viewer.classList.remove('is-closing');
  }, 260);
}

// ---------- События ----------

backBtn.addEventListener('click', () => history.back());
viewerClose.addEventListener('click', () => history.back());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !viewer.hidden) history.back();
});

searchInput.addEventListener('input', () => {
  query = searchInput.value;
  searchClear.hidden = !query;
  render();
});

searchClear.addEventListener('click', () => {
  query = '';
  searchInput.value = '';
  searchClear.hidden = true;
  searchInput.focus();
  render();
});

load();

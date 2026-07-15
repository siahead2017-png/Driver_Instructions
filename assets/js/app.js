import { toEmbedUrl, typeMeta } from './drive.js';
import { getRecent, pushRecent } from './store.js';

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

async function load() {
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

function cardHTML(item) {
  const t = typeMeta(item.type);
  return `
    <a class="card" href="#/item/${encodeURIComponent(item.id)}">
      <span class="card__badge card__badge--${esc(item.type)}" aria-hidden="true">${t.icon}</span>
      <span class="card__body">
        <span class="card__title">${esc(item.title)}</span>
        ${item.description ? `<span class="card__desc">${esc(item.description)}</span>` : ''}
        <span class="card__meta">${esc(t.label)}${item.updated ? ` · ${fmtDate(item.updated)}` : ''}</span>
      </span>
      <svg class="card__chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>
    </a>`;
}

function renderHome() {
  setHeader('Инструкции', false);

  const recent = getRecent().map(byId).filter(Boolean);
  const recentHTML = recent.length
    ? `<section class="section">
         <h2 class="section__title">Недавние</h2>
         <div class="list">${recent.map(cardHTML).join('')}</div>
       </section>`
    : '';

  const tiles = data.categories
    .map((c) => {
      const n = itemsOf(c.id).length;
      return `
        <a class="tile" href="#/category/${encodeURIComponent(c.id)}">
          <span class="tile__icon" aria-hidden="true">${esc(c.icon ?? '📁')}</span>
          <span class="tile__title">${esc(c.title)}</span>
          <span class="tile__count">${n} ${plural(n, 'инструкция', 'инструкции', 'инструкций')}</span>
        </a>`;
    })
    .join('');

  view.innerHTML = `
    ${recentHTML}
    <section class="section">
      <h2 class="section__title">Категории</h2>
      <div class="tiles">${tiles}</div>
    </section>`;
}

function renderCategory(cat) {
  setHeader(cat.title, true);

  const items = itemsOf(cat.id);
  if (!items.length) {
    view.innerHTML = `<div class="empty"><div class="empty__icon">📭</div>
      <p class="empty__title">Пока пусто</p>
      <p class="empty__text">В этой категории ещё нет инструкций.</p></div>`;
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

  view.innerHTML = sorted
    .map(([sub, list]) => `
      <section class="section">
        ${sub ? `<h2 class="section__title">${esc(sub)}</h2>` : ''}
        <div class="list">${list.map(cardHTML).join('')}</div>
      </section>`)
    .join('');
}

function renderSearch() {
  setHeader('Поиск', false);
  const q = query.trim().toLowerCase();
  const hits = data.items.filter((i) =>
    [i.title, i.description, ...(i.tags ?? [])].join(' ').toLowerCase().includes(q));

  view.innerHTML = hits.length
    ? `<section class="section">
         <h2 class="section__title">Найдено: ${hits.length}</h2>
         <div class="list">${hits.map(cardHTML).join('')}</div>
       </section>`
    : `<div class="empty"><div class="empty__icon">🔍</div>
         <p class="empty__title">Ничего не найдено</p>
         <p class="empty__text">Попробуй другое слово.</p></div>`;
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

function closeViewer() {
  if (viewer.hidden) return;
  viewerOpenId = null;
  viewer.hidden = true;
  viewerBody.innerHTML = ''; // выгружаем iframe, иначе видео продолжает играть
  document.body.classList.remove('is-locked');
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

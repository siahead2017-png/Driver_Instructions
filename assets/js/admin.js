// Админка обращений водителей.
//
// Обычный скрипт, не модуль: отдельная страница, импортировать ей нечего.
// Пароль здесь НЕ проверяется — он уходит на сервер, и данные отдаёт сервер.
// В этом файле нет и не может быть ни пароля, ни токена бота: страница лежит
// в публичном репозитории и читается кем угодно.
//
// Бэкенд — тот же Apps Script Web App, что принимает обращения от водителей
// (проект Driver_Feedback_Backend, вне git).

// Тот же адрес, что в assets/js/feedback.js. При обновлении Code.gs адрес не
// меняется — достаточно развернуть «Новую версию» существующего развёртывания.
var ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbz1iR6G08OuQgMQK_VOsZR20qdGw-1BjuR13j_azYLGa8lfiUeqY-VizYBHnnYQbAVSww/exec';

var PASS_KEY = 'di:admin:pass';     // sessionStorage: закрыл вкладку — вход заново
var REFRESH_MS = 60 * 1000;

var STATUS_CLASS = {
  'Новый': 'new',
  'В работе': 'work',
  'Закрыт': 'done',
};

var el = {
  login: document.getElementById('login'),
  loginForm: document.getElementById('login-form'),
  loginPass: document.getElementById('login-pass'),
  loginError: document.getElementById('login-error'),
  loginBtn: document.getElementById('login-btn'),

  app: document.getElementById('app'),
  count: document.getElementById('count'),
  refresh: document.getElementById('refresh'),
  logout: document.getElementById('logout'),
  search: document.getElementById('search'),
  filterStatus: document.getElementById('filter-status'),
  filterTopic: document.getElementById('filter-topic'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
};

var pass = '';
var tickets = [];
var statuses = [];
var topics = [];
var fStatus = 'все';
var fTopic = 'все';
var query = '';
var timer = null;

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function post(payload) {
  return fetch(ENDPOINT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },   // без preflight, см. feedback.js
    body: JSON.stringify(payload),
  }).then(function (res) { return res.json(); });
}

function fmtDate(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d)) return String(iso);
  var p = function (n) { return String(n).padStart(2, '0'); };
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' КБ';
  return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
}

// ---------- Вход ----------

function showLoginError(msg) {
  el.loginError.textContent = msg;
  el.loginError.hidden = false;
}

function login(value) {
  el.loginBtn.disabled = true;
  el.loginBtn.textContent = 'Проверяем…';
  el.loginError.hidden = true;

  return post({ action: 'list', pass: value })
    .then(function (data) {
      if (data && data.ok) {
        pass = value;
        try { sessionStorage.setItem(PASS_KEY, value); } catch (e) { /* не критично */ }
        el.login.hidden = true;
        el.app.hidden = false;
        apply(data);
        startAutoRefresh();
        return true;
      }

      var code = data && data.error;
      if (code === 'locked') {
        showLoginError('Вход временно закрыт: было слишком много неудачных попыток. Подождите 10 минут.');
      } else if (code === 'bad_password') {
        showLoginError('Неверный пароль.');
      } else {
        showLoginError('Сервер ответил ошибкой: ' + (code || 'неизвестно'));
      }
      return false;
    })
    .catch(function () {
      showLoginError('Нет связи с сервером. Проверьте интернет.');
      return false;
    })
    .finally(function () {
      el.loginBtn.disabled = false;
      el.loginBtn.textContent = 'Войти';
    });
}

function logout() {
  pass = '';
  tickets = [];
  try { sessionStorage.removeItem(PASS_KEY); } catch (e) { /* не критично */ }
  clearInterval(timer);
  el.app.hidden = true;
  el.login.hidden = false;
  el.loginPass.value = '';
  el.loginPass.focus();
}

// ---------- Загрузка ----------

function apply(data) {
  tickets = data.tickets || [];
  statuses = data.statuses || [];
  topics = data.topics || [];
  paintFilters();
  paint();
}

function reload() {
  el.refresh.classList.add('is-spinning');
  return post({ action: 'list', pass: pass })
    .then(function (data) {
      if (data && data.ok) { apply(data); return; }
      // Пароль сменили или вход заблокирован — честно выкидываем на экран входа,
      // а не показываем устаревший список как актуальный.
      if (data && (data.error === 'bad_password' || data.error === 'locked')) logout();
    })
    .catch(function () { /* обрыв связи — оставляем на экране то, что уже показано */ })
    .finally(function () { el.refresh.classList.remove('is-spinning'); });
}

function startAutoRefresh() {
  clearInterval(timer);
  timer = setInterval(reload, REFRESH_MS);
}

// ---------- Фильтры ----------

function chips(container, values, active, attr) {
  container.innerHTML = ['все'].concat(values).map(function (v) {
    return '<button type="button" class="chip' + (v === active ? ' is-active' : '') +
      '" data-' + attr + '="' + esc(v) + '">' + esc(v === 'все' ? 'Все' : v) + '</button>';
  }).join('');
}

function paintFilters() {
  chips(el.filterStatus, statuses, fStatus, 'status');
  chips(el.filterTopic, topics, fTopic, 'topic');
}

function visible() {
  var q = query.trim().toLowerCase();
  return tickets.filter(function (t) {
    if (fStatus !== 'все' && t.status !== fStatus) return false;
    if (fTopic !== 'все' && t.topic !== fTopic) return false;
    if (!q) return true;
    return [t.ticket, t.name, t.phone, t.topic, t.text, t.note, t.truck, t.trailer]
      .join(' ').toLowerCase().indexOf(q) >= 0;
  });
}

// ---------- Отрисовка ----------

function paint() {
  var rows = visible();

  el.count.textContent = rows.length === tickets.length
    ? String(tickets.length)
    : rows.length + ' из ' + tickets.length;

  if (!rows.length) {
    el.list.innerHTML = '';
    el.empty.hidden = false;
    el.empty.textContent = tickets.length
      ? 'Под фильтр ничего не подходит.'
      : 'Обращений пока нет.';
    return;
  }

  el.empty.hidden = true;
  el.list.innerHTML = rows.map(cardHTML).join('');
}

function cardHTML(t) {
  var digits = String(t.phone || '').replace(/\D/g, '');

  var files = (t.files || []).map(function (f, i) {
    return '<button type="button" class="file" data-ticket="' + esc(t.ticket) + '" data-index="' + i + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>' +
      '<span class="file__name">' + esc(f.name) + '</span>' +
      '<span class="file__size">' + fmtSize(f.size) + '</span></button>';
  }).join('');

  // Номера машин показываем только когда они есть: у вопроса или пожелания их
  // обычно нет, и пустая строка «Тягач: —» в каждой карточке только мешает.
  var plateItems = '' +
    (t.truck ? '<span class="plate"><b>Тягач</b>' + esc(t.truck) + '</span>' : '') +
    (t.trailer ? '<span class="plate"><b>Прицеп</b>' + esc(t.trailer) + '</span>' : '');
  var plates = plateItems ? '<div class="card__plates">' + plateItems + '</div>' : '';

  var statusBtns = statuses.map(function (s) {
    return '<button type="button" class="status status--' + (STATUS_CLASS[s] || 'new') +
      (s === t.status ? ' is-active' : '') +
      '" data-ticket="' + esc(t.ticket) + '" data-status="' + esc(s) + '">' + esc(s) + '</button>';
  }).join('');

  return '' +
    '<article class="card card--' + (STATUS_CLASS[t.status] || 'new') + '" data-ticket="' + esc(t.ticket) + '">' +
      '<div class="card__head">' +
        '<span class="card__num">#' + esc(t.ticket) + '</span>' +
        '<span class="card__topic">' + esc(t.topic) + '</span>' +
        '<span class="card__date">' + esc(fmtDate(t.createdAt)) + '</span>' +
      '</div>' +

      '<div class="card__who">' +
        '<span class="card__name">' + esc(t.name) + '</span>' +
        (digits
          ? '<a class="wa" href="https://wa.me/' + esc(digits) + '" target="_blank" rel="noopener">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M21 11.5a8.4 8.4 0 01-9 8.4 9.1 9.1 0 01-3.3-.6L3 21l1.8-5.3A8.2 8.2 0 013.6 11 8.4 8.4 0 0112 3a8.4 8.4 0 019 8.5z"/></svg>' +
            esc(t.phone) + '</a>'
          : '') +
      '</div>' +

      plates +

      (t.text ? '<p class="card__text">' + esc(t.text) + '</p>' : '<p class="card__text card__text--none">без текста</p>') +

      (files ? '<div class="card__files">' + files + '</div>' : '') +

      '<div class="card__statuses">' + statusBtns + '</div>' +

      '<textarea class="note" data-ticket="' + esc(t.ticket) + '" rows="1" maxlength="1000" ' +
        'title="Сохраняется автоматически, когда уходите из поля" ' +
        'placeholder="Заметка для себя">' + esc(t.note || '') + '</textarea>' +
    '</article>';
}

// ---------- Действия ----------

function setStatus(ticket, value) {
  var t = tickets.filter(function (x) { return x.ticket === ticket; })[0];
  if (!t || t.status === value) return;

  var prev = t.status;
  t.status = value;   // рисуем сразу, не дожидаясь сервера
  paint();

  post({ action: 'status', pass: pass, ticket: ticket, value: value })
    .then(function (data) {
      if (!data || !data.ok) throw new Error('rejected');
    })
    .catch(function () {
      t.status = prev;   // сервер не принял — возвращаем как было, чтобы экран не врал
      paint();
      alert('Не удалось сменить статус. Проверьте связь и попробуйте ещё раз.');
    });
}

function saveNote(ticket, value) {
  var t = tickets.filter(function (x) { return x.ticket === ticket; })[0];
  if (!t || (t.note || '') === value) return;

  t.note = value;
  post({ action: 'note', pass: pass, ticket: ticket, value: value })
    .catch(function () { alert('Заметка не сохранилась — проверьте связь.'); });
}

// Файл тянем через сервер: у него есть токен бота, у страницы — нет.
// Ответ приходит как base64, здесь он превращается обратно в файл.
function download(btn, ticket, index) {
  var old = btn.querySelector('.file__size').textContent;
  btn.disabled = true;
  btn.querySelector('.file__size').textContent = 'качаем…';

  post({ action: 'download', pass: pass, ticket: ticket, index: index })
    .then(function (data) {
      if (!data || !data.ok) throw new Error((data && data.error) || 'failed');

      var raw = atob(data.b64);
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

      var url = URL.createObjectURL(new Blob([bytes], { type: data.mime || 'application/octet-stream' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = data.name || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    })
    .catch(function (err) {
      alert('Не удалось скачать файл: ' + err.message + '\n\nФайл всегда есть в Telegram-чате, под номером этого обращения.');
    })
    .finally(function () {
      btn.disabled = false;
      btn.querySelector('.file__size').textContent = old;
    });
}

// ---------- События ----------

el.loginForm.addEventListener('submit', function (e) {
  e.preventDefault();
  if (!ENDPOINT_URL) {
    showLoginError('Адрес сервера ещё не прописан в admin.js — админка не подключена.');
    return;
  }
  var value = el.loginPass.value.trim();
  if (value) login(value);
});

el.refresh.addEventListener('click', reload);
el.logout.addEventListener('click', logout);

el.search.addEventListener('input', function () { query = el.search.value; paint(); });

el.filterStatus.addEventListener('click', function (e) {
  var chip = e.target.closest('.chip');
  if (!chip) return;
  fStatus = chip.dataset.status;
  paintFilters();
  paint();
});

el.filterTopic.addEventListener('click', function (e) {
  var chip = e.target.closest('.chip');
  if (!chip) return;
  fTopic = chip.dataset.topic;
  paintFilters();
  paint();
});

el.list.addEventListener('click', function (e) {
  var status = e.target.closest('.status');
  if (status) { setStatus(status.dataset.ticket, status.dataset.status); return; }

  var file = e.target.closest('.file');
  if (file) { download(file, file.dataset.ticket, Number(file.dataset.index)); }
});

// Заметка сохраняется при уходе из поля: сохранять на каждую букву — значит
// слать запрос к Apps Script на каждое нажатие и жечь суточную квоту.
el.list.addEventListener('focusout', function (e) {
  if (e.target.classList.contains('note')) saveNote(e.target.dataset.ticket, e.target.value.trim());
});

// Автовход, если пароль уже вводили в этой вкладке.
(function () {
  var saved = '';
  try { saved = sessionStorage.getItem(PASS_KEY) || ''; } catch (e) { /* не критично */ }
  if (saved && ENDPOINT_URL) login(saved);
  else el.loginPass.focus();
})();

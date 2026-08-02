// Регистрация водителя после инструктажа: ФИО/дата рождения/e-mail + подпись.
// Самодостаточный модуль по образцу guide.js — свой виртуальный экран #/register,
// открывается автоматически с последнего шага гида («Готово»). app.js его не
// знает: route()/render() не распознают 'register' и уходят в renderHome(),
// как уже происходит с 'guide' — контракт описан в CLAUDE.md.
//
// Payload уходит в Apps Script Web App (ENDPOINT_URL) — Content-Type: text/plain,
// чтобы не ловить CORS-preflight (проверено вручную с боевого домена, см. CLAUDE.md).
// localStorage (di:register:last) — не источник истины, а подстраховка на случай
// обрыва сети: пишется до отправки и стирается только при успешном ответе сервера.

const ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbyXEGa18iJf5B6XKTnsmNn89ZJ11cfrHeBjShTaOQ015mDa5ak0h6PXjn400e6nUKEn/exec';

// Водитель может устраиваться не только в HEAD — выбор компании определяет,
// с каким письмом-шапкой/реквизитами Apps Script соберёт PDF (см. Code.gs, CONFIG.TEMPLATES).
// HEAD — первая в списке и выбрана по умолчанию, так исторически большинство водителей.
const COMPANIES = [
  { id: 'HEAD', label: 'SIA HEAD', logo: 'assets/img/logo-head.png?v=1' },
  { id: 'HDLG', label: 'SIA HD LOGISTICS GROUP', logo: 'assets/img/logo-hdlg.png?v=1' },
];

// Текст ниже дублирует тело PDF-шаблонов (Driver_Instructions_Backend/PDF_TEMPLATES.txt,
// без шапки с логотипом/реквизитами) — водитель должен видеть, под чем расписывается,
// ДО подписи, а не только в PDF постфактум. Текст держится в двух местах (сайт и Doc-
// шаблоны) вручную: при правке формулировок поправить оба.
const CONFIRM_TOPICS = [
  'Отчёты и документы — порядок оформления, предоставления и сроки сдачи.',
  'Использование служебного телефона и обязательных приложений для взаимодействия с менеджерами и другими отделами.',
  'Заправки топлива и ADBLUE, согласно инструкции.',
  'Порядок оплаты виньеток и иных обязательных платежей на маршруте, работу с дорожными боксами и их контроль.',
  'Правила использования топливных карт и установленные ограничения.',
  'Правила использования корпоративной банковской карты.',
  'Обязательная фотофиксация состояния транспортного средства (тягача и прицепа) и оборудования при получении, перецепах и сдаче.',
  'Правила эксплуатации транспортного средства, соблюдение внутренних регламентов компании и ответственность за их нарушение.',
];

// Текст на экране — от второго лица («вы подтверждаете»), т.к. это ещё
// предпросмотр ДО подписи; в самом PDF (PDF_TEMPLATES.txt) та же суть
// изложена от первого лица («настоящим подтверждаю»), как в подписываемом
// документе. Меняете формулировки — правьте оба места вручную.
function confirmationHtml(companyId) {
  return `
    <div class="register__confirm" id="register-confirm">
      <p>Подписывая, вы подтверждаете, что прошли вводный инструктаж, ознакомлены с порядком работы, понимаете содержание изложенных требований, получили необходимые разъяснения и не имеете вопросов относительно порядка исполнения своих обязанностей.</p>
      <p>В ходе инструктажа вы были ознакомлены, в том числе, со следующими вопросами:</p>
      <ol class="register__confirm-list">
        ${CONFIRM_TOPICS.map((t) => `<li>${esc(t)}</li>`).join('')}
      </ol>
      <p>Вы обязуетесь соблюдать указанные требования, внутренние нормативные документы компании, а также незамедлительно сообщать диспетчеру или иному уполномоченному представителю компании о любых обстоятельствах, препятствующих их соблюдению или влияющих на безопасность перевозки.</p>
      <p>Вам известно, что несоблюдение указанных требований может повлечь применение мер ответственности, предусмотренных законодательством, трудовым договором, внутренними нормативными документами компании и иными подписанными вами соглашениями.</p>
      <p>Вы подтверждаете, что ознакомлены с информацией об обработке ваших персональных данных компанией <strong>${esc(companyLabel(companyId))}</strong>. Ваши персональные данные (ФИО, дата рождения, e-mail, изображение подписи и иные данные, связанные с прохождением инструктажа) обрабатываются в целях документирования прохождения инструктажа, исполнения обязанностей работодателя и хранения соответствующих записей в соответствии с применимым законодательством о защите персональных данных.</p>
    </div>
  `;
}

const KEY = 'di:register:last';

const el = document.getElementById('register');
const closeBtn = document.getElementById('register-close');
const bodyEl = document.getElementById('register-body');
const actionBtn = document.getElementById('register-action');

let pad = null; // SignaturePad — живёт, пока не пересобрана форма (renderForm())

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

// ---------- Хеш (своя копия парсера, как и в guide.js — route() в app.js не экспортирована) ----------

function parseScreen() {
  const hash = location.hash.slice(2);
  return hash.split('/')[0] || 'home';
}

// ---------- Формат дат: везде dd.mm.yyyy, ISO остаётся только в <input type="date"> ----------

function fmtDateRu(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

function ageYears(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
}

// ---------- Форма ----------

function renderForm() {
  bodyEl.innerHTML = `
    <p class="register__intro">Инструктаж пройден. Заполните данные и распишитесь ниже — этим Вы подтверждаете, что ознакомлены с инструктажем.</p>

    <div class="calc__field">
      <span class="calc__field-label">Компания трудоустройства</span>
      <div class="register__companies">
        ${COMPANIES.map((c, i) => `
          <label class="register__company">
            <input type="radio" name="reg-company" value="${c.id}" ${i === 0 ? 'checked' : ''}>
            <img src="${c.logo}" alt="${esc(c.label)}">
          </label>
        `).join('')}
      </div>
    </div>

    <div class="register__names">
      <label class="calc__field">
        <span class="calc__field-label">Фамилия</span>
        <input class="calc__input" id="reg-last" type="text" autocomplete="family-name" placeholder="Иванов">
      </label>
      <label class="calc__field">
        <span class="calc__field-label">Имя</span>
        <input class="calc__input" id="reg-first" type="text" autocomplete="given-name" placeholder="Иван">
      </label>
    </div>

    <label class="calc__field">
      <span class="calc__field-label">Дата рождения</span>
      <input class="calc__input" id="reg-birth" type="date" autocomplete="bday">
    </label>

    <label class="calc__field">
      <span class="calc__field-label">E-mail (необязательно)</span>
      <input class="calc__input" id="reg-email" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com">
    </label>

    ${confirmationHtml(COMPANIES[0].id)}

    <div class="register__sig">
      <span class="calc__field-label">Подпись</span>
      <div class="register__pad" id="register-pad">
        <canvas id="reg-signature"></canvas>
      </div>
      <button class="register__sig-clear" id="reg-sig-clear" type="button">Очистить подпись</button>
    </div>

    <p class="register__error" id="register-error" hidden></p>
  `;

  // Канвас меряет свой размер через getBoundingClientRect() — контейнер обязан
  // быть уже видимым (el.hidden === false к этому моменту, см. showRegister()),
  // иначе SignaturePad посчитает себя 0×0 и подпись некуда будет рисовать.
  const canvas = document.getElementById('reg-signature');
  const padWrap = document.getElementById('register-pad');
  pad = new SignaturePad(canvas, {
    onChange: (p) => padWrap.classList.toggle('is-filled', !p.isEmpty()),
  });

  document.getElementById('reg-sig-clear').addEventListener('click', () => pad.clear());

  // Текст согласия называет компанию — при смене выбора наверху перерисовываем
  // только этот блок (не всю форму, иначе слетит canvas/pad).
  document.querySelectorAll('input[name="reg-company"]').forEach((input) => {
    input.addEventListener('change', () => {
      document.getElementById('register-confirm').outerHTML = confirmationHtml(input.value);
    });
  });

  actionBtn.textContent = 'Отправить';
  actionBtn.onclick = handleSubmit;
}

function showError(msg) {
  const box = document.getElementById('register-error');
  if (box) { box.textContent = msg; box.hidden = false; }
}

function readFields() {
  const companyInput = document.querySelector('input[name="reg-company"]:checked');
  return {
    company: companyInput ? companyInput.value : COMPANIES[0].id,
    lastName: document.getElementById('reg-last').value.trim(),
    firstName: document.getElementById('reg-first').value.trim(),
    birth: document.getElementById('reg-birth').value,
    email: document.getElementById('reg-email').value.trim(),
  };
}

function companyLabel(id) {
  return COMPANIES.find((c) => c.id === id)?.label || id;
}

// E-mail не проверяется здесь на «пусто» — пустой e-mail не ошибка формы,
// а отдельное подтверждение через confirm() в handleSubmit (водитель может
// не иметь рабочей почты, отправка всё равно уходит в Sheet/PDF).
function validate({ lastName, firstName, birth, email }) {
  if (lastName.length < 2) return 'Укажите фамилию.';
  if (firstName.length < 2) return 'Укажите имя.';
  if (!birth) return 'Укажите дату рождения.';
  const age = ageYears(birth);
  if (age === null || age < 16 || age > 90) return 'Проверьте дату рождения.';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Проверьте e-mail — похоже, в нём опечатка.';
  if (!pad || pad.isEmpty()) return 'Распишитесь в поле подписи.';
  return null;
}

function handleSubmit() {
  const fields = readFields();
  const err = validate(fields);
  if (err) { showError(err); return; }

  if (!fields.email) {
    const proceed = confirm('E-mail не указан — подтверждение прохождения инструктажа не придёт на почту (данные всё равно сохранятся). Отправить без e-mail?');
    if (!proceed) return;
  }

  const payload = {
    company: fields.company,
    lastName: fields.lastName,
    firstName: fields.firstName,
    birthDate: fmtDateRu(fields.birth),
    email: fields.email,
    signature: pad.toDataURL('image/png', { trim: true, background: '#fff' }),
    submittedAt: new Date().toISOString(),
  };

  // Пишем до отправки: если fetch не пройдёт (обрыв сети), данные не потеряются.
  try { localStorage.setItem(KEY, JSON.stringify(payload)); } catch { /* приватный режим — не критично */ }

  submitPayload(payload);
}

function submitPayload(payload) {
  renderSending();

  fetch(ENDPOINT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' }, // без preflight — см. CLAUDE.md
    body: JSON.stringify(payload),
  })
    .then((res) => res.json())
    .then((data) => {
      if (!data.ok) throw new Error(data.error || 'server error');
      try { localStorage.removeItem(KEY); } catch { /* не критично */ }
      renderDone(payload);
    })
    .catch((e) => {
      console.error('Отправка регистрации не удалась:', e);
      renderSubmitError(payload);
    });
}

function renderSending() {
  bodyEl.innerHTML = `
    <div class="register__sending">
      <div class="spinner" aria-hidden="true"></div>
      <p>Отправляем данные…</p>
    </div>
  `;
  actionBtn.disabled = true;
}

function renderSubmitError(payload) {
  bodyEl.innerHTML = `
    <div class="register__done">
      <div class="register__done-icon" aria-hidden="true">⚠️</div>
      <h2 class="register__done-title">Не получилось отправить</h2>
      <p class="register__done-text">Проверьте интернет-соединение и попробуйте ещё раз. Данные не потеряны — они сохранены на этом устройстве.</p>
    </div>
  `;
  actionBtn.disabled = false;
  actionBtn.textContent = 'Повторить';
  actionBtn.onclick = () => submitPayload(payload);
}

function renderDone(payload) {
  const doneText = payload.email
    ? 'Инструктаж подтверждён, PDF отправлен на вашу почту.'
    : 'Инструктаж подтверждён. E-mail не указан — PDF на почту не придёт, но данные сохранены.';

  bodyEl.innerHTML = `
    <div class="register__done">
      <div class="register__done-icon" aria-hidden="true">✅</div>
      <h2 class="register__done-title">Данные собраны</h2>
      <p class="register__done-text">${doneText}</p>
      <dl class="register__summary">
        <dt>Компания</dt><dd>${esc(companyLabel(payload.company))}</dd>
        <dt>ФИО</dt><dd>${esc(payload.lastName)} ${esc(payload.firstName)}</dd>
        <dt>Дата рождения</dt><dd>${esc(payload.birthDate)}</dd>
        <dt>E-mail</dt><dd>${payload.email ? esc(payload.email) : 'не указан'}</dd>
      </dl>
      <img class="register__sig-preview" src="${payload.signature}" alt="Подпись">
    </div>
  `;

  actionBtn.disabled = false;

  actionBtn.textContent = 'Заполнить ещё раз';
  actionBtn.onclick = renderForm;
}

// ---------- Показ / скрытие, синхронизация с хешем (паттерн из guide.js) ----------

let closeTimer = null;

function showRegister() {
  clearTimeout(closeTimer);
  el.classList.remove('is-closing');
  el.hidden = false; // до renderForm() — см. комментарий про размер канваса
  document.body.classList.add('is-locked');

  const fab = document.getElementById('calc-fab');
  if (fab) fab.hidden = true;

  if (!pad) renderForm();

  el.classList.add('is-opening');
  setTimeout(() => el.classList.remove('is-opening'), 20);
}

function hideRegister() {
  if (el.hidden || el.classList.contains('is-closing')) return;

  // is-locked и calc-fab общие с guide/viewer: снимаем/возвращаем только если
  // оба сейчас закрыты — иначе собьём то, что уже выставил открывшийся экран
  // (тот же приём, что в guide.js для конфликта с viewer).
  const guide = document.getElementById('guide');
  const viewer = document.getElementById('viewer');
  const guideOpen = !!guide && !guide.hidden;
  const viewerOpen = !!viewer && !viewer.hidden;

  if (!guideOpen && !viewerOpen) document.body.classList.remove('is-locked');
  const fab = document.getElementById('calc-fab');
  if (fab && !guideOpen) fab.hidden = false;

  el.classList.add('is-closing');
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    el.hidden = true;
    el.classList.remove('is-closing');
  }, 220);
}

function closeRegister() {
  history.back();
}

closeBtn.addEventListener('click', closeRegister);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.hidden) closeRegister();
});

function syncFromHash() {
  if (parseScreen() !== 'register') { hideRegister(); return; }
  showRegister();
}

window.addEventListener('hashchange', syncFromHash);
syncFromHash(); // прямой заход по ссылке на #/register

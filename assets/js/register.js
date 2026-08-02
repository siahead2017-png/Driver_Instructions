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
const closeDoneBtn = document.getElementById('register-close-done');
closeDoneBtn.addEventListener('click', () => { location.hash = ''; }); // на главную, тот же приём, что у guide-home

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

// ---------- Дата рождения: свободный ввод dd.mm.yyyy + пикер Год/Месяц/День ----------
// Родной <input type="date"> заменён: на телефоне владельца он открывал календарь
// сразу на сегодняшнем дне, и пролистывать на 20-40 лет назад до нужного года было
// тяжело. Теперь основной способ — печатать цифры (мобильная цифровая клавиатура
// через inputmode="numeric", маска сама расставляет точки), а раскрывающийся пикер
// с тремя select'ами — для тех, кто предпочитает тапать, а не печатать.

const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MIN_AGE = 18; // ниже — не пускаем, это не только правило компании, но и ловит опечатки в годе
const MAX_AGE = 90; // выше — почти наверняка опечатка в годе, а не реальный возраст

const pad2 = (n) => String(n).padStart(2, '0');

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate(); // month: 1-12, день 0 следующего месяца = последний день этого
}

// Разбирает ДД.ММ.ГГГГ и проверяет, что дата реально существует (не «31.02.1990»):
// new Date() сама «перетекает» несуществующие даты на соседний месяц, поэтому
// результат сверяется обратно с исходными числами.
function parseBirthInput(text) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec((text || '').trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

function ageYears(date) {
  return (Date.now() - date.getTime()) / (365.25 * 24 * 3600 * 1000);
}

// Маска: цифры набираются свободно (в т.ч. одной длинной последовательностью),
// точки после дня и месяца расставляются сами. Курсор при этом улетает в конец
// поля — для десятизначной даты, которую печатают слева направо не редактируя
// середину, это приемлемо и не мешает набору.
function maskBirthInput(e) {
  const digits = e.target.value.replace(/\D/g, '').slice(0, 8);
  let out = digits.slice(0, 2);
  if (digits.length > 2) out += '.' + digits.slice(2, 4);
  if (digits.length > 4) out += '.' + digits.slice(4, 8);
  e.target.value = out;
}

// Три select'а — Год, Месяц, День (в этом порядке, чтобы сначала выбирался год:
// для родившихся 20-40 лет назад это избавляет от пролистывания месяцев).
// Список дней пересчитывается при смене года/месяца, чтобы в феврале не было 30-31.
function populateBirthPicker() {
  const yearSel = document.getElementById('reg-birth-year');
  const monthSel = document.getElementById('reg-birth-month');
  const daySel = document.getElementById('reg-birth-day');

  const nowYear = new Date().getFullYear();
  const years = [];
  for (let y = nowYear - MIN_AGE; y >= nowYear - MAX_AGE; y--) years.push(y);

  yearSel.innerHTML = '<option value="">Год</option>' + years.map((y) => `<option value="${y}">${y}</option>`).join('');
  monthSel.innerHTML = '<option value="">Месяц</option>' + MONTHS_RU.map((name, i) => `<option value="${i + 1}">${name}</option>`).join('');

  const syncDayOptions = () => {
    const y = Number(yearSel.value) || null;
    const m = Number(monthSel.value) || null;
    const max = y && m ? daysInMonth(y, m) : 31;
    const current = Number(daySel.value) || null;
    daySel.innerHTML = '<option value="">День</option>' + Array.from({ length: max }, (_, i) => i + 1)
      .map((d) => `<option value="${d}"${d === current ? ' selected' : ''}>${d}</option>`).join('');
  };
  syncDayOptions();

  const applyIfComplete = () => {
    if (yearSel.value && monthSel.value && daySel.value) {
      document.getElementById('reg-birth-text').value = `${pad2(daySel.value)}.${pad2(monthSel.value)}.${yearSel.value}`;
    }
  };

  yearSel.addEventListener('change', () => { syncDayOptions(); applyIfComplete(); });
  monthSel.addEventListener('change', () => { syncDayOptions(); applyIfComplete(); });
  daySel.addEventListener('change', applyIfComplete);
}

// ---------- Форма ----------

function renderForm() {
  // Повторный вызов (после «Заполнить ещё раз») обязан начинать с чистой подписи —
  // canvas в .sig-full статичен в index.html, а не пересобирается вместе с формой,
  // поэтому старые чернила сами по себе не пропадут. При первом вызове pad ещё
  // не существует (создаётся лениво в ensureFullSigPad() при первом открытии).
  if (pad) pad.clear();

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

    <div class="calc__field">
      <label class="calc__field-label" for="reg-birth-text">Дата рождения</label>
      <input class="calc__input" id="reg-birth-text" type="text" inputmode="numeric" autocomplete="bday" placeholder="ДД.ММ.ГГГГ" maxlength="10">
      <button type="button" class="register__birth-toggle" id="reg-birth-toggle">Выбрать по шагам: год → месяц → день</button>
      <div class="register__birth-picker" id="reg-birth-picker" hidden>
        <select class="calc__input" id="reg-birth-year" aria-label="Год рождения"></select>
        <select class="calc__input" id="reg-birth-month" aria-label="Месяц рождения"></select>
        <select class="calc__input" id="reg-birth-day" aria-label="День рождения"></select>
      </div>
    </div>

    <label class="calc__field">
      <span class="calc__field-label">E-mail (необязательно)</span>
      <input class="calc__input" id="reg-email" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com">
    </label>

    ${confirmationHtml(COMPANIES[0].id)}

    <div class="register__sig">
      <span class="calc__field-label">Подпись</span>
      <button type="button" class="register__pad" id="register-pad" aria-label="Открыть подпись на весь экран">
        <img class="register__pad-preview" id="register-pad-preview" alt="Подпись" hidden>
      </button>
    </div>

    <p class="register__error" id="register-error" hidden></p>
  `;

  // Маленькое поле в форме больше не рисует само (на узком телефоне в нём
  // неудобно расписываться) — тап открывает полноэкранный .sig-full, там и
  // живёт единственный canvas/SignaturePad, см. openSigFull()/updatePadPreview()
  // ниже. Здесь только превью уже нарисованного (пусто до первой подписи).
  document.getElementById('register-pad').addEventListener('click', openSigFull);
  updatePadPreview();

  document.getElementById('reg-birth-text').addEventListener('input', maskBirthInput);
  populateBirthPicker();
  document.getElementById('reg-birth-toggle').addEventListener('click', (e) => {
    const picker = document.getElementById('reg-birth-picker');
    picker.hidden = !picker.hidden;
    e.target.textContent = picker.hidden
      ? 'Выбрать по шагам: год → месяц → день'
      : 'Скрыть выбор по шагам';
  });

  // Текст согласия называет компанию — при смене выбора наверху перерисовываем
  // только этот блок (не всю форму, иначе слетит canvas/pad).
  document.querySelectorAll('input[name="reg-company"]').forEach((input) => {
    input.addEventListener('change', () => {
      document.getElementById('register-confirm').outerHTML = confirmationHtml(input.value);
    });
  });

  closeDoneBtn.hidden = true; // виден только на экране «Данные собраны», см. renderDone()
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
    birth: document.getElementById('reg-birth-text').value.trim(),
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
  const date = parseBirthInput(birth);
  if (!date) return 'Проверьте дату рождения — похоже, такой даты не существует.';
  if (date.getTime() > Date.now()) return 'Дата рождения не может быть в будущем — проверьте дату.';
  const age = ageYears(date);
  if (age < MIN_AGE) return `Судя по дате рождения, водителю ещё нет ${MIN_AGE} лет — проверьте дату.`;
  if (age > MAX_AGE) return 'Проверьте дату рождения — похоже на опечатку в годе.';
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

  const birthDate = parseBirthInput(fields.birth);
  const payload = {
    company: fields.company,
    lastName: fields.lastName,
    firstName: fields.firstName,
    birthDate: `${pad2(birthDate.getDate())}.${pad2(birthDate.getMonth() + 1)}.${birthDate.getFullYear()}`,
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

  closeDoneBtn.hidden = false;
  actionBtn.textContent = 'Заполнить ещё раз';
  actionBtn.onclick = renderForm;
}

// ---------- Полноэкранная подпись ----------
// Маленькое поле .register__pad в форме — только превью и кнопка «открыть»;
// сам SignaturePad живёт на canvas внутри .sig-full (статичный узел в
// index.html, не пересоздаётся вместе с формой). Открывается/закрывается без
// изменения хеша: это не отдельный экран приложения, а временное состояние
// уже открытой регистрации — пуш ещё одной записи в history добавил бы
// путаницу с «Назад», не отражая ничего нового по смыслу URL.

function updatePadPreview() {
  const img = document.getElementById('register-pad-preview');
  const wrap = document.getElementById('register-pad');
  if (!img || !wrap) return; // форма могла уже пересобраться (renderForm) — узлы старые
  if (!pad || pad.isEmpty()) {
    img.hidden = true;
    img.removeAttribute('src');
    wrap.classList.remove('is-filled');
    return;
  }
  img.src = pad.toDataURL('image/png', { trim: true });
  img.hidden = false;
  wrap.classList.add('is-filled');
}

// Канвас .sig-full создаётся один раз на всю сессию (не при каждом открытии) —
// тот же приём, что и с прежним inline-канвасом: getBoundingClientRect() должен
// мерить уже видимый контейнер, поэтому создание — только после el.hidden = false.
function ensureFullSigPad() {
  if (pad) return;
  const canvas = document.getElementById('sig-full-canvas');
  pad = new SignaturePad(canvas, { onChange: updatePadPreview });
}

let sigFullCloseTimer = null;

function openSigFull() {
  const el = document.getElementById('sig-full');
  clearTimeout(sigFullCloseTimer);
  el.classList.remove('is-closing');
  el.hidden = false;
  ensureFullSigPad();
  el.classList.add('is-opening');
  setTimeout(() => el.classList.remove('is-opening'), 20);
}

function closeSigFull() {
  const el = document.getElementById('sig-full');
  if (el.hidden || el.classList.contains('is-closing')) return;
  el.classList.add('is-closing');
  clearTimeout(sigFullCloseTimer);
  sigFullCloseTimer = setTimeout(() => {
    el.hidden = true;
    el.classList.remove('is-closing');
  }, 220);
  updatePadPreview();
}

document.getElementById('sig-full-done').addEventListener('click', closeSigFull);
document.getElementById('sig-full-clear').addEventListener('click', () => { if (pad) pad.clear(); });

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
  if (e.key !== 'Escape') return;
  const sigFull = document.getElementById('sig-full');
  // Полноэкранная подпись открыта поверх регистрации — Escape должен закрыть
  // сначала её, а не выкинуть из всей формы разом.
  if (sigFull && !sigFull.hidden) { closeSigFull(); return; }
  if (!el.hidden) closeRegister();
});

// Гид хранит прогресс отдельно (di:guide) — свой модуль, без общего состояния
// с app.js, поэтому здесь читаем его напрямую. Не только защита от чипов в
// гиде (см. guide.js resolveStepId): #/register — обычный хеш, на него можно
// зайти по прямой ссылке/закладке в обход гида целиком, минуя ту защиту.
// Возвращает id первого непройденного шага, либо null (гид пройден полностью),
// либо false (не удалось проверить — данные гида не загрузились).
async function firstIncompleteGuideStep() {
  try {
    const res = await fetch(`data/guide.json?v=${Date.now()}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error('fetch failed');
    const guideData = await res.json();
    let done = {};
    try { done = (JSON.parse(localStorage.getItem('di:guide') || 'null') || {}).done || {}; } catch { /* пусто */ }
    for (const block of guideData.blocks) {
      for (const step of block.steps) {
        if (step.confirm && !done[step.id]) return step.id;
      }
    }
    return null;
  } catch (err) {
    console.error('Регистрация: не удалось проверить прогресс гида', err);
    return false;
  }
}

async function syncFromHash() {
  if (parseScreen() !== 'register') { hideRegister(); return; }

  const gate = await firstIncompleteGuideStep();
  if (gate === null) {
    showRegister();
  } else if (gate) {
    // Не весь гид пройден — отправляем на первый непройденный шаг, а не в форму.
    location.hash = `#/guide/${encodeURIComponent(gate)}`;
  } else {
    // Данные гида не загрузились — не пускаем в форму вслепую, но и не рушим
    // навигацию: отправляем в сам гид, он сам разберётся, с какого шага начать.
    location.hash = '#/guide';
  }
}

window.addEventListener('hashchange', syncFromHash);
syncFromHash(); // прямой заход по ссылке на #/register

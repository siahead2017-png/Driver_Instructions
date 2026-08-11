// Обратная связь водителя: вопрос / жалоба / предложение в офис.
// Самодостаточный модуль по образцу bans.js и guide.js: ничего не импортирует
// из app.js и не экспортирует наружу, сам следит за адресной строкой и
// показывает себя на #/feedback. Роутер app.js про этот хеш не знает и рисует
// под нами главную — это штатное поведение (см. CLAUDE.md).
//
// Бэкенд — отдельный Apps Script Web App (проект Driver_Feedback_Backend, вне
// git). Он выдаёт номер тикета, пишет строку в Google Таблицу и пересылает
// всё в Telegram-группу обратной связи.

// Адрес Web App. Обязан лежать в открытом JS — иначе форма не сможет
// отправить обращение; ровно так же тут лежит ENDPOINT_URL инструктажа.
// Секреты (токен бота, chat_id, пароль админки) остаются на стороне сервера.
// Если строку когда-нибудь очистить, экран честно напишет «ещё не подключено»
// и не станет притворяться рабочим — тот же приём, что был у bans.js.
const ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbz1iR6G08OuQgMQK_VOsZR20qdGw-1BjuR13j_azYLGa8lfiUeqY-VizYBHnnYQbAVSww/exec';

const DRAFT_KEY = 'di:feedback:draft';
const COOLDOWN_KEY = 'di:feedback:cooldownUntil';
const COOLDOWN_MS = 60 * 1000;

// Порядок и написание тем должны совпадать с TOPICS в Code.gs: сервер сверяет
// пришедшее значение со своим списком и незнакомое молча заменяет на «Прочее».
const TOPICS = ['Вопрос', 'Заявка на ремонт', 'Пожелание', 'Жалоба', 'Предложение', 'Прочее'];

// Единственная тема, для которой номера тягача и прицепа обязательны. Ту же
// проверку делает и сервер (REPAIR_TOPIC в Code.gs) — строка должна совпадать
// с точностью до буквы, иначе сервер отобьёт заявку, прошедшую в браузере.
const REPAIR_TOPIC = 'Заявка на ремонт';
const PLATE_MIN = 3;

const MAX_FILES = 6;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 2000;

// Запись голосового. 3 минуты — потолок разумного сообщения; при 32 кбит/с
// это меньше 800 КБ, что спокойно уходит даже на плохой связи.
const REC_MAX_MS = 3 * 60 * 1000;
const REC_BITRATE = 32000;

// Сжатие фотографий прямо в телефоне, до отправки. Снимок накладной на 6 МБ
// превращается в ~400 КБ, а мелкий текст на 1600 px по длинной стороне всё
// ещё читается. Для водителя в роуминге это разница между «ушло за пару
// секунд» и «висит и падает».
const IMG_MAX_SIDE = 1600;
const IMG_QUALITY = 0.8;

const ALLOWED_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx'];

const ERRORS = {
  bad_name: 'Укажите имя и фамилию.',
  bad_phone: 'Проверьте номер WhatsApp — нужен международный формат с кодом страны.',
  bad_truck: 'Для заявки на ремонт укажите номер тягача.',
  bad_trailer: 'Для заявки на ремонт укажите номер прицепа.',
  empty: 'Напишите сообщение или приложите файл.',
  rate_limited: 'Вы только что отправили обращение. Подождите минуту и попробуйте снова.',
  busy: 'Сервер сейчас занят. Попробуйте ещё раз через несколько секунд.',
  server_error: 'Сервер не смог обработать обращение. Попробуйте ещё раз.',
  no_endpoint: 'Обратная связь ещё не подключена. Позвоните в офис, как обычно.',
};

const el = {
  root: document.getElementById('feedback'),
  fab: document.getElementById('fb-fab'),
  close: document.getElementById('fb-close'),
  title: document.getElementById('fb-title'),

  form: document.getElementById('fb-form'),
  sending: document.getElementById('fb-sending'),
  done: document.getElementById('fb-done'),

  hp: document.getElementById('fb-website'),
  name: document.getElementById('fb-name'),
  phone: document.getElementById('fb-phone'),
  topics: document.getElementById('fb-topics'),
  truck: document.getElementById('fb-truck'),
  trailer: document.getElementById('fb-trailer'),
  truckReq: document.getElementById('fb-truck-req'),
  trailerReq: document.getElementById('fb-trailer-req'),
  platesHint: document.getElementById('fb-plates-hint'),
  text: document.getElementById('fb-text'),
  counter: document.getElementById('fb-counter'),

  recBtn: document.getElementById('fb-rec-btn'),
  recState: document.getElementById('fb-rec-state'),
  recDel: document.getElementById('fb-rec-del'),
  recAudio: document.getElementById('fb-rec-audio'),

  attach: document.getElementById('fb-attach'),
  fileInput: document.getElementById('fb-file'),
  fileList: document.getElementById('fb-files'),
  filesHint: document.getElementById('fb-files-hint'),

  error: document.getElementById('fb-error'),

  sendingText: document.getElementById('fb-sending-text'),
  progress: document.getElementById('fb-progress'),
  progressFill: document.getElementById('fb-progress-fill'),

  doneNum: document.getElementById('fb-done-num'),
  doneText: document.getElementById('fb-done-text'),

  send: document.getElementById('fb-send'),
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

let attachments = [];   // { blob, name, mime, kind: 'file' | 'voice' }
let topic = TOPICS[0];
let closeTimer = null;
let sending = false;

// Запись голосового
let recorder = null;
let recChunks = [];
let recStream = null;
let recTimer = null;
let recStartedAt = 0;

// ---------- Черновик ----------

// Файлы и запись в черновик не кладём: Blob в localStorage не сериализуется,
// а гонять их через base64 в хранилище на 5 МБ — верный способ его переполнить.
function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      name: el.name.value,
      phone: el.phone.value,
      topic: topic,
      text: el.text.value,
      truck: el.truck.value,
      trailer: el.trailer.value,
    }));
  } catch { /* приватный режим — не критично */ }
}

function loadDraft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  } catch {
    return null;
  }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* не критично */ }
}

// Имя подставляем из данных инструктажа, если водитель его уже проходил на
// этом телефоне: заставлять вводить одно и то же дважды незачем.
function nameFromRegister() {
  try {
    const d = JSON.parse(localStorage.getItem('di:register:draft') || 'null');
    if (!d) return '';
    return [d.firstName, d.lastName].filter(Boolean).join(' ').trim();
  } catch {
    return '';
  }
}

function cooldownLeft() {
  try {
    return Math.max(0, Number(localStorage.getItem(COOLDOWN_KEY) || 0) - Date.now());
  } catch {
    return 0;
  }
}

function setCooldown() {
  try { localStorage.setItem(COOLDOWN_KEY, String(Date.now() + COOLDOWN_MS)); } catch { /* не критично */ }
}

// ---------- Мелочи ----------

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' КБ';
  const mb = bytes / 1024 / 1024;
  // Целое число мегабайт пишем без «,0»: лимит должен читаться как «20 МБ».
  const shown = Number.isInteger(mb) ? String(mb) : mb.toFixed(1).replace('.', ',');
  return shown + ' МБ';
}

function fmtTime(ms) {
  const total = Math.floor(ms / 1000);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

function totalBytes() {
  return attachments.reduce((sum, a) => sum + a.blob.size, 0);
}

function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

// Госномер приводим к тому же виду, что и сервер (plate_ в Code.gs): заглавные,
// одиночные пробелы, любое тире — обычным дефисом. Иначе один прицеп попадёт
// в Таблицу как «hd 1234», «HD-1234» и «HD—1234», и поиск его не найдёт.
// Формат не навязываем: машины HEAD/HDLG зарегистрированы в разных странах.
function plate(v) {
  return String(v || '')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, 20);
}

function showError(msg) {
  el.error.textContent = msg;
  el.error.hidden = false;
  el.error.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function hideError() {
  el.error.hidden = true;
}

// ---------- Маска телефона ----------

// Коды стран, по которым реально ездят водители HEAD/HDLG. Нужны ТОЛЬКО для
// красивой разбивки пробелами: цифры маска не меняет никогда, и на сервер
// уходят одни цифры. Незнакомый код ничего не ломает — номер просто разобьётся
// без выделенного кода страны.
const COUNTRY_CODES = [
  '7',
  '30', '31', '32', '33', '34', '36', '39', '40', '43', '44', '45', '46', '47', '48', '49',
  '351', '352', '353', '358', '359', '370', '371', '372', '375', '380', '385', '386', '420', '421',
];

function splitPhone(digits) {
  for (const len of [3, 2, 1]) {
    const code = digits.slice(0, len);
    if (COUNTRY_CODES.indexOf(code) >= 0) return [code, digits.slice(len)];
  }
  return ['', digits];
}

// Абонентскую часть режем по три цифры СПРАВА: так 20123456 превращается в
// «20 123 456» — как латвийский номер и принято писать, — а не в «201 234 56».
function groupFromRight(s) {
  const out = [];
  for (let i = s.length; i > 0; i -= 3) out.unshift(s.slice(Math.max(0, i - 3), i));
  return out.join(' ');
}

function formatPhone(digits) {
  if (!digits) return '';
  const [code, rest] = splitPhone(digits);
  return code ? ('+' + code + ' ' + groupFromRight(rest)).trim() : '+' + groupFromRight(digits);
}

function maskPhone(e) {
  const input = e.target;
  const digitsBefore = digitsOnly(input.value.slice(0, input.selectionStart)).length;

  const next = formatPhone(digitsOnly(input.value).slice(0, 15));
  if (next === input.value) return;

  input.value = next;

  // Курсор возвращаем к той же по счёту цифре, а не в хвост: иначе правка
  // середины номера была бы невозможна — курсор прыгал бы на каждом нажатии.
  let pos = next.length;
  if (digitsBefore === 0) {
    pos = Math.min(1, next.length);
  } else {
    let seen = 0;
    for (let i = 0; i < next.length; i++) {
      if (next[i] >= '0' && next[i] <= '9' && ++seen === digitsBefore) { pos = i + 1; break; }
    }
  }
  input.setSelectionRange(pos, pos);
}

// ---------- Темы обращения ----------

function paintTopics() {
  el.topics.innerHTML = TOPICS.map((t) => `
    <button type="button" class="fb__topic${t === topic ? ' is-active' : ''}"
      data-topic="${esc(t)}" aria-pressed="${t === topic}">${esc(t)}</button>
  `).join('');

  paintPlates();
}

/**
 * Поля номеров не прячем при смене темы, а только помечаем обязательными.
 *
 * Спрятать было бы «чище», но водитель, уже вписавший номер и потом сменивший
 * тему, увидел бы, как введённое исчезает с экрана — и решил бы, что данные
 * потерялись. Номер машины полезен и в жалобе, и в вопросе: пусть остаётся.
 */
function paintPlates() {
  const need = topic === REPAIR_TOPIC;

  el.truckReq.hidden = !need;
  el.trailerReq.hidden = !need;
  el.platesHint.hidden = !need;

  el.truck.required = need;
  el.trailer.required = need;
}

// ---------- Вложения ----------

function paintFiles() {
  if (!attachments.length) {
    el.fileList.innerHTML = '';
    el.fileList.hidden = true;
  } else {
    el.fileList.hidden = false;
    el.fileList.innerHTML = attachments.map((a, i) => `
      <li class="fb__file">
        <span class="fb__file-icon" aria-hidden="true">${a.kind === 'voice' ? '🎤' : fileIcon(a.mime, a.name)}</span>
        <span class="fb__file-name">${esc(a.name)}</span>
        <span class="fb__file-size">${fmtSize(a.blob.size)}</span>
        <button type="button" class="fb__file-del" data-index="${i}" aria-label="Убрать ${esc(a.name)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </li>
    `).join('');
  }

  const used = totalBytes();
  el.filesHint.textContent = attachments.length
    ? `${attachments.length} из ${MAX_FILES} · ${fmtSize(used)} из ${fmtSize(MAX_TOTAL_BYTES)}`
    : `До ${MAX_FILES} файлов, всего не больше ${fmtSize(MAX_TOTAL_BYTES)}. Фото сжимаются автоматически.`;

  el.attach.disabled = attachments.length >= MAX_FILES;
}

function fileIcon(mime, name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (ext === 'pdf') return '📕';
  if (ext === 'doc' || ext === 'docx') return '📘';
  if (ext === 'xls' || ext === 'xlsx') return '📗';
  return '📎';
}

function isAllowed(file) {
  if (/^(image|video|audio)\//.test(file.type)) return true;
  const ext = file.name.split('.').pop().toLowerCase();
  return ALLOWED_EXT.indexOf(ext) >= 0;
}

/**
 * Уменьшение фотографии до отправки.
 * Через <img> + canvas, а не createImageBitmap: <img> работает во всех
 * браузерах, которыми пользуются водители, включая старые Safari на iPhone.
 * Если что-то пошло не так (например, HEIC, который браузер не умеет
 * декодировать) — молча возвращаем оригинал, ошибку водителю не показываем.
 */
function compressImage(file) {
  return new Promise((resolve) => {
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) { resolve(file); return; }

    const url = URL.createObjectURL(file);
    const img = new Image();

    const fail = () => { URL.revokeObjectURL(url); resolve(file); };

    img.onerror = fail;
    img.onload = () => {
      try {
        const scale = Math.min(1, IMG_MAX_SIDE / Math.max(img.width, img.height));
        if (scale === 1 && file.size <= 1024 * 1024) { fail(); return; }

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          // Берём сжатую версию только если она реально легче: у маленьких
          // PNG-скриншотов пережатие в JPEG иногда даёт больший файл.
          resolve(blob && blob.size < file.size ? blob : file);
        }, 'image/jpeg', IMG_QUALITY);
      } catch {
        fail();
      }
    };

    img.src = url;
  });
}

async function addFiles(fileList) {
  hideError();
  const incoming = Array.from(fileList || []);
  if (!incoming.length) return;

  const rejected = [];

  for (const file of incoming) {
    if (attachments.length >= MAX_FILES) {
      rejected.push(`${file.name} — больше ${MAX_FILES} файлов нельзя`);
      continue;
    }
    if (!isAllowed(file)) {
      rejected.push(`${file.name} — такой формат не принимается`);
      continue;
    }

    const blob = await compressImage(file);

    if (blob.size > MAX_FILE_BYTES) {
      rejected.push(`${file.name} — ${fmtSize(blob.size)}, а один файл может быть до ${fmtSize(MAX_FILE_BYTES)}`);
      continue;
    }
    if (totalBytes() + blob.size > MAX_TOTAL_BYTES) {
      rejected.push(`${file.name} — не влезает в общий лимит ${fmtSize(MAX_TOTAL_BYTES)}`);
      continue;
    }

    // Имя оставляем исходное: водителю и офису важно видеть «накладная.pdf»,
    // а не «blob». Расширение правим, только если фото реально пережали.
    const name = (blob !== file && /^image\//i.test(file.type))
      ? file.name.replace(/\.[^.]+$/, '') + '.jpg'
      : file.name;

    attachments.push({ blob, name, mime: blob.type || file.type, kind: 'file' });
  }

  paintFiles();
  if (rejected.length) showError('Не добавлено:\n• ' + rejected.join('\n• '));
}

// ---------- Голосовое ----------

function recSupported() {
  return typeof MediaRecorder !== 'undefined'
    && navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function';
}

// Android/Chrome пишет webm/opus, iPhone/Safari — mp4. Без этой проверки на
// одном из них запись просто не запускается.
function pickRecMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';   // пусть браузер выберет сам
}

function hasVoice() {
  return attachments.some((a) => a.kind === 'voice');
}

async function startRec() {
  hideError();

  if (!recSupported()) {
    showError('Этот браузер не умеет записывать звук. Напишите текстом или приложите файл.');
    return;
  }
  if (attachments.length >= MAX_FILES) {
    showError(`Уже ${MAX_FILES} вложений — больше нельзя.`);
    return;
  }

  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showError('Нет доступа к микрофону. Разрешите запись звука в настройках браузера.');
    return;
  }

  const mimeType = pickRecMime();
  recChunks = [];

  try {
    recorder = new MediaRecorder(recStream, mimeType
      ? { mimeType, audioBitsPerSecond: REC_BITRATE }
      : { audioBitsPerSecond: REC_BITRATE });
  } catch {
    stopStream();
    showError('Не удалось начать запись. Напишите текстом или приложите файл.');
    return;
  }

  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = onRecStop;

  recorder.start();
  recStartedAt = Date.now();
  el.root.classList.add('is-recording');
  el.recBtn.classList.add('is-recording');
  el.recBtn.setAttribute('aria-label', 'Остановить запись');

  recTimer = setInterval(() => {
    const elapsed = Date.now() - recStartedAt;
    el.recState.textContent = 'Идёт запись… ' + fmtTime(elapsed);
    if (elapsed >= REC_MAX_MS) stopRec();
  }, 200);

  el.recState.textContent = 'Идёт запись… 0:00';
}

function stopRec() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

function stopStream() {
  if (recStream) {
    recStream.getTracks().forEach((t) => t.stop());
    recStream = null;
  }
}

function onRecStop() {
  clearInterval(recTimer);
  el.root.classList.remove('is-recording');
  el.recBtn.classList.remove('is-recording');
  el.recBtn.setAttribute('aria-label', 'Записать голосовое сообщение');
  stopStream();

  const mime = (recorder && recorder.mimeType) || 'audio/webm';
  const blob = new Blob(recChunks, { type: mime });
  recChunks = [];
  recorder = null;

  if (!blob.size) {
    el.recState.textContent = 'Запись не получилась, попробуйте ещё раз';
    return;
  }
  if (totalBytes() + blob.size > MAX_TOTAL_BYTES) {
    el.recState.textContent = 'Нажмите, чтобы записать';
    showError('Запись не помещается в общий лимит — уберите один из файлов.');
    return;
  }

  const ext = mime.indexOf('mp4') >= 0 ? 'm4a' : (mime.indexOf('ogg') >= 0 ? 'ogg' : 'webm');
  attachments.push({
    blob,
    name: 'Голосовое сообщение.' + ext,
    mime,
    kind: 'voice',
  });

  el.recAudio.src = URL.createObjectURL(blob);
  el.recAudio.hidden = false;
  el.recDel.hidden = false;
  el.recBtn.hidden = true;
  el.recState.textContent = 'Запись готова · ' + fmtSize(blob.size);

  paintFiles();
}

function deleteVoice() {
  attachments = attachments.filter((a) => a.kind !== 'voice');
  if (el.recAudio.src) URL.revokeObjectURL(el.recAudio.src);
  el.recAudio.removeAttribute('src');
  el.recAudio.hidden = true;
  el.recDel.hidden = true;
  el.recBtn.hidden = false;
  el.recState.textContent = 'Нажмите, чтобы записать';
  paintFiles();
}

// ---------- Отправка ----------

function post(payload) {
  // Content-Type: text/plain — чтобы браузер не делал preflight-запрос:
  // Apps Script на OPTIONS отвечать не умеет. Тот же приём, что в register.js.
  return fetch(ENDPOINT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload),
  }).then((res) => res.json());
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const s = String(reader.result);
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    reader.readAsDataURL(blob);
  });
}

function validate() {
  if (el.name.value.trim().length < 2) return ERRORS.bad_name;

  const digits = digitsOnly(el.phone.value);
  if (digits.length < 8 || digits.length > 15) return ERRORS.bad_phone;

  // Ровно то же правило стоит на сервере: форму можно обойти, отправив запрос
  // напрямую, поэтому проверка здесь — про удобство, а не про защиту.
  if (topic === REPAIR_TOPIC) {
    if (plate(el.truck.value).length < PLATE_MIN) return ERRORS.bad_truck;
    if (plate(el.trailer.value).length < PLATE_MIN) return ERRORS.bad_trailer;
  }

  if (!el.text.value.trim() && !attachments.length) return ERRORS.empty;

  return '';
}

function setScreen(name) {
  el.form.hidden = name !== 'form';
  el.sending.hidden = name !== 'sending';
  el.done.hidden = name !== 'done';
  el.send.hidden = name !== 'form';
}

async function send() {
  if (sending) return;
  hideError();

  if (!ENDPOINT_URL) { showError(ERRORS.no_endpoint); return; }

  const problem = validate();
  if (problem) { showError(problem); return; }

  const left = cooldownLeft();
  if (left > 0) {
    showError(`Вы только что отправили обращение. Подождите ${Math.ceil(left / 1000)} с.`);
    return;
  }

  sending = true;
  setScreen('sending');
  el.sendingText.textContent = 'Отправляем обращение…';
  el.progress.hidden = true;

  let data;
  try {
    data = await post({
      action: 'ticket',
      website: el.hp.value,            // honeypot: у человека всегда пустой
      name: el.name.value.trim(),
      phone: digitsOnly(el.phone.value),
      topic: topic,
      text: el.text.value.trim().slice(0, MAX_TEXT),
      truck: plate(el.truck.value),
      trailer: plate(el.trailer.value),
      filesCount: attachments.length,
    });
  } catch {
    sending = false;
    setScreen('form');
    showError('Не получилось отправить. Проверьте интернет и попробуйте ещё раз — набранное не потеряно.');
    return;
  }

  if (!data || !data.ok) {
    sending = false;
    setScreen('form');
    const code = (data && data.error) || 'server_error';
    if (code === 'rate_limited') setCooldown();
    showError(ERRORS[code] || ERRORS.server_error);
    return;
  }

  const ticket = data.ticket;

  // Тикет уже создан и уже в Telegram. Дальше файлы — по одному, и падение
  // любого из них больше не отменяет обращение целиком.
  const failed = [];
  if (attachments.length) {
    el.progress.hidden = false;
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      el.sendingText.textContent = `Отправляем файл ${i + 1} из ${attachments.length}…`;
      el.progressFill.style.width = Math.round((i / attachments.length) * 100) + '%';

      const sent = await sendOne(ticket, a);
      if (!sent) failed.push(a.name);
    }
    el.progressFill.style.width = '100%';
  }

  setCooldown();
  clearDraft();
  sending = false;
  renderDone(ticket, failed);
}

// Две попытки на файл: чаще всего повторная проходит — обрыв в роуминге
// обычно короткий.
async function sendOne(ticket, a) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const b64 = await blobToBase64(a.blob);
      const res = await post({
        action: 'file',
        ticket,
        name: a.name,
        mime: a.mime,
        kind: a.kind,
        dataB64: b64,
      });
      if (res && res.ok) return true;
    } catch { /* пробуем ещё раз */ }
  }
  return false;
}

function renderDone(ticket, failed) {
  setScreen('done');
  el.doneNum.textContent = '#' + ticket;

  el.doneText.innerHTML = failed.length
    ? `Обращение принято, но ${failed.length === 1 ? 'файл не дошёл' : 'часть файлов не дошла'}:
       <br><b>${esc(failed.join(', '))}</b>
       <br><br>Напишите ещё раз, указав номер обращения, — или пришлите файл в WhatsApp.
       Мы ответим на указанный вами номер.`
    : 'Мы получили ваше обращение и ответим в WhatsApp на указанный номер.<br>Запишите номер обращения — по нему проще найти вашу заявку.';

  // Форму под следующее обращение чистим сразу, а не по кнопке: телефон в
  // кабине часто передают из рук в руки.
  attachments = [];
  el.text.value = '';
  if (el.recAudio.src) URL.revokeObjectURL(el.recAudio.src);
  el.recAudio.removeAttribute('src');
  el.recAudio.hidden = true;
  el.recDel.hidden = true;
  el.recBtn.hidden = false;
  el.recState.textContent = 'Нажмите, чтобы записать';
  paintFiles();
  paintCounter();
}

// ---------- Счётчик символов ----------

function paintCounter() {
  const left = MAX_TEXT - el.text.value.length;
  el.counter.textContent = `осталось ${left}`;
  el.counter.classList.toggle('is-low', left < 100);
}

// ---------- Показ / скрытие ----------

/**
 * Кнопки-FAB прячем всегда, когда открыт ЛЮБОЙ оверлей: без hidden они
 * визуально перекрыты z-index'ом, но остаются в tab-order и ловят фокус
 * позади открытого экрана (на этом в проекте уже стояли, см. CLAUDE.md).
 *
 * Признак «что-то открыто» — класс is-locked на body: его ставят и viewer, и
 * calc, и guide, и register, и bans. Опираемся на него, а не на список id,
 * чтобы новая кнопка не требовала правок в четырёх чужих модулях — они про
 * неё не знают и знать не должны.
 */
function syncFab() {
  const locked = document.body.classList.contains('is-locked');
  if (el.fab) el.fab.hidden = locked;

  const calcFab = document.getElementById('calc-fab');
  if (calcFab) calcFab.hidden = locked;
}

function show() {
  clearTimeout(closeTimer);
  el.root.classList.remove('is-closing');
  el.root.hidden = false;
  document.body.classList.add('is-locked');
  syncFab();

  setScreen('form');
  hideError();

  const draft = loadDraft() || {};
  if (!el.name.value) el.name.value = draft.name || nameFromRegister();
  if (!el.phone.value) el.phone.value = draft.phone || '';
  if (!el.text.value) el.text.value = (draft.text || '').slice(0, MAX_TEXT);
  if (!el.truck.value) el.truck.value = draft.truck || '';
  if (!el.trailer.value) el.trailer.value = draft.trailer || '';
  if (draft.topic && TOPICS.indexOf(draft.topic) >= 0) topic = draft.topic;

  paintTopics();
  paintFiles();
  paintCounter();

  if (!recSupported()) {
    el.recBtn.disabled = true;
    el.recState.textContent = 'Этот браузер не умеет записывать звук';
  }

  el.root.classList.add('is-opening');
  setTimeout(() => el.root.classList.remove('is-opening'), 20);
}

function hide() {
  if (el.root.hidden || el.root.classList.contains('is-closing')) { syncFab(); return; }

  // Бросили экран посреди записи — микрофон обязан погаснуть.
  if (recorder && recorder.state !== 'inactive') stopRec();
  stopStream();

  // Блокировку скролла снимаем только если её не держит открытая карточка.
  const viewer = document.getElementById('viewer');
  if (!viewer || viewer.hidden) document.body.classList.remove('is-locked');
  syncFab();

  el.root.classList.add('is-closing');
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    el.root.hidden = true;
    el.root.classList.remove('is-closing');
  }, 220);
}

function syncFromHash() {
  if (location.hash.slice(2).split('/')[0] !== 'feedback') { hide(); return; }
  show();
}

// ---------- События ----------

if (el.root) {
  if (el.fab) el.fab.addEventListener('click', () => { location.hash = '#/feedback'; });
  el.close.addEventListener('click', () => history.back());

  el.topics.addEventListener('click', (e) => {
    const btn = e.target.closest('.fb__topic');
    if (!btn) return;
    topic = btn.dataset.topic;
    paintTopics();
    saveDraft();
  });

  el.phone.addEventListener('input', maskPhone);

  [el.name, el.phone, el.text, el.truck, el.trailer].forEach((input) => {
    input.addEventListener('input', saveDraft);
  });

  // Номер приводим к общему виду не на каждой букве, а когда водитель ушёл из
  // поля: иначе toUpperCase() посреди набора дёргает курсор на части Android.
  [el.truck, el.trailer].forEach((input) => {
    input.addEventListener('blur', () => {
      const fixed = plate(input.value);
      if (fixed !== input.value) { input.value = fixed; saveDraft(); }
    });
  });

  el.text.addEventListener('input', paintCounter);

  el.attach.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', async () => {
    await addFiles(el.fileInput.files);
    el.fileInput.value = '';   // иначе повторный выбор того же файла не сработает
  });

  el.fileList.addEventListener('click', (e) => {
    const btn = e.target.closest('.fb__file-del');
    if (!btn) return;
    const removed = attachments[Number(btn.dataset.index)];
    if (removed && removed.kind === 'voice') { deleteVoice(); return; }
    attachments.splice(Number(btn.dataset.index), 1);
    paintFiles();
  });

  el.recBtn.addEventListener('click', () => {
    if (recorder && recorder.state === 'recording') stopRec();
    else startRec();
  });

  el.recDel.addEventListener('click', deleteVoice);

  el.send.addEventListener('click', send);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.root.hidden && !sending) location.hash = '#/';
  });

  // Гид, регистрация, запреты и калькулятор про кнопку обратной связи не знают
  // и прячут только свою. Следим за is-locked сами — так новый экран не требует
  // правок в четырёх чужих модулях.
  new MutationObserver(syncFab).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  window.addEventListener('hashchange', syncFromHash);
  syncFromHash();   // прямой заход по ссылке, а не только по событию
  syncFab();
}

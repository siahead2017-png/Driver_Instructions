// Локальное хранилище: недавно открытые инструкции.
// Всё в try/catch — в приватном режиме localStorage может бросать исключение.

const KEY = 'di:recent';
// Не больше трёх: иначе блок «Недавние» отжимает категории вниз экрана.
const LIMIT = 3;
// Через минуту после открытия инструкция уходит из «Недавних».
export const RECENT_TTL = 60_000;

// Читаем сырые записи вида { id, t }. Старый формат (просто строки-id)
// приводим к новому с t = 0, чтобы такие записи считались просроченными.
function readRaw() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    return JSON.parse(raw).map((e) => (typeof e === 'string' ? { id: e, t: 0 } : e));
  } catch {
    return [];
  }
}

function fresh(entries, now = Date.now()) {
  return entries.filter((e) => e.t && now - e.t < RECENT_TTL);
}

export function getRecent() {
  return fresh(readRaw()).slice(0, LIMIT).map((e) => e.id);
}

// Момент (мс), когда истечёт ближайшая из «Недавних», либо null.
export function nextRecentExpiry() {
  const times = fresh(readRaw()).slice(0, LIMIT).map((e) => e.t + RECENT_TTL);
  return times.length ? Math.min(...times) : null;
}

export function pushRecent(id) {
  try {
    const now = Date.now();
    const kept = fresh(readRaw(), now).filter((e) => e.id !== id);
    const next = [{ id, t: now }, ...kept].slice(0, LIMIT);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* недоступно — не критично */
  }
}

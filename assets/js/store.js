// Локальное хранилище: недавно открытые инструкции.
// Всё в try/catch — в приватном режиме localStorage может бросать исключение.

const KEY = 'di:recent';
const LIMIT = 6;

export function getRecent() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function pushRecent(id) {
  try {
    const next = [id, ...getRecent().filter((x) => x !== id)].slice(0, LIMIT);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* недоступно — не критично */
  }
}

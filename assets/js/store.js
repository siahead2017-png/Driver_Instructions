// Локальное хранилище: недавно открытые инструкции.
// Всё в try/catch — в приватном режиме localStorage может бросать исключение.

const KEY = 'di:recent';
// Не больше трёх: иначе блок «Недавние» отжимает категории вниз экрана.
const LIMIT = 3;

export function getRecent() {
  try {
    const raw = localStorage.getItem(KEY);
    // Режем и при чтении: у тех, кто заходил раньше, в телефоне может
    // лежать список длиннее нынешнего лимита.
    return raw ? JSON.parse(raw).slice(0, LIMIT) : [];
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

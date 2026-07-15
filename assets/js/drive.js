// Разбор ссылок Google Диска и построение URL для встроенного просмотра.

const ID_PATTERNS = [
  /\/d\/([\w-]{10,})/,        // .../file/d/{ID}/view, .../document/d/{ID}/edit
  /[?&]id=([\w-]{10,})/,      // .../open?id={ID}, .../uc?id={ID}
  /\/folders\/([\w-]{10,})/,  // .../drive/folders/{ID}
];

/** Достаёт file ID из любой формы ссылки Google Диска. Возвращает null, если это не Диск. */
export function extractDriveId(url) {
  if (typeof url !== 'string') return null;
  for (const re of ID_PATTERNS) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

const EMBED_BASE = {
  doc: (id) => `https://docs.google.com/document/d/${id}/preview`,
  sheet: (id) => `https://docs.google.com/spreadsheets/d/${id}/preview`,
  slide: (id) => `https://docs.google.com/presentation/d/${id}/preview`,
};

/**
 * Строит URL для iframe.
 * Возвращает null, если встроить нельзя — тогда показываем кнопку «Открыть в новой вкладке».
 */
export function toEmbedUrl(item) {
  const id = extractDriveId(item.url);
  if (!id) {
    // Не Диск: YouTube отдельно, остальное — только внешней ссылкой.
    const yt = item.url?.match(/(?:youtu\.be\/|[?&]v=|youtube\.com\/embed\/)([\w-]{11})/);
    if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
    return null;
  }
  const special = EMBED_BASE[item.type];
  if (special) return special(id);
  // pdf, video и любой другой файл на Диске
  return `https://drive.google.com/file/d/${id}/preview`;
}

const TYPE_META = {
  pdf:   { label: 'PDF',       icon: '📄' },
  doc:   { label: 'Документ',  icon: '📝' },
  sheet: { label: 'Таблица',   icon: '📊' },
  slide: { label: 'Презентация', icon: '📽️' },
  image: { label: 'Картинка',  icon: '🖼️' },
  video: { label: 'Видео',     icon: '🎬' },
  link:  { label: 'Ссылка',    icon: '🔗' },
};

export function typeMeta(type) {
  return TYPE_META[type] ?? TYPE_META.link;
}

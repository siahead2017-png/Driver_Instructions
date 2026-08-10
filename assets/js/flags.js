// Флаги стран для экрана запретов — рисованные SVG, а не эмодзи.
//
// Почему не эмодзи 🇵🇱. Windows вообще не умеет рисовать флаговые эмодзи: там,
// где на телефоне флаг, в браузере на компьютере видны просто буквы «PL».
// То же самое на части старых Android. Экран нужен и водителю на телефоне, и
// владельцу на компьютере, поэтому флаги рисуем сами — тогда они одинаковые
// везде и не зависят от шрифта системы.
//
// Гербы (Испания, Словакия, Словения) намеренно НЕ рисуем: на 21×15 пикселей
// герб превращается в грязное пятно, а файл вырос бы втрое. Полосы узнаваемы
// и без него. Это осознанное решение, не недоделка.
//
// Пропорции 21:15 у всех, включая Швейцарию (её настоящий флаг квадратный) —
// иначе в списке один чип выбивался бы по ширине.

export const FLAGS = {
  PL: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#fff"/>'
    + '<rect y="7.5" width="21" height="7.5" fill="#dc143c"/></svg>',

  DE: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#000"/>'
    + '<rect y="5" width="21" height="5" fill="#d00"/>'
    + '<rect y="10" width="21" height="5" fill="#ffce00"/></svg>',

  FR: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#fff"/>'
    + '<rect width="7" height="15" fill="#002395"/>'
    + '<rect x="14" width="7" height="15" fill="#ed2939"/></svg>',

  ES: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#aa151b"/>'
    + '<rect y="3.75" width="21" height="7.5" fill="#f1bf00"/></svg>',

  AT: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#ed2939"/>'
    + '<rect y="5" width="21" height="5" fill="#fff"/></svg>',

  CZ: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#fff"/>'
    + '<rect y="7.5" width="21" height="7.5" fill="#d7141a"/>'
    + '<path d="M0 0 10.5 7.5 0 15Z" fill="#11457e"/></svg>',

  HU: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#fff"/>'
    + '<rect width="21" height="5" fill="#ce2939"/>'
    + '<rect y="10" width="21" height="5" fill="#477050"/></svg>',

  IT: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#fff"/>'
    + '<rect width="7" height="15" fill="#009246"/>'
    + '<rect x="14" width="7" height="15" fill="#ce2b37"/></svg>',

  SE: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#006aa7"/>'
    + '<rect x="6" width="3" height="15" fill="#fecc00"/>'
    + '<rect y="6" width="21" height="3" fill="#fecc00"/></svg>',

  DK: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#c8102e"/>'
    + '<rect x="6" width="3" height="15" fill="#fff"/>'
    + '<rect y="6" width="21" height="3" fill="#fff"/></svg>',

  RO: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#fcd116"/>'
    + '<rect width="7" height="15" fill="#002b7f"/>'
    + '<rect x="14" width="7" height="15" fill="#ce1126"/></svg>',

  LV: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#9e3039"/>'
    + '<rect y="6" width="21" height="3" fill="#fff"/></svg>',

  LT: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#fdb913"/>'
    + '<rect y="5" width="21" height="5" fill="#006a44"/>'
    + '<rect y="10" width="21" height="5" fill="#c1272d"/></svg>',

  SK: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#fff"/>'
    + '<rect y="5" width="21" height="5" fill="#0b4ea2"/>'
    + '<rect y="10" width="21" height="5" fill="#ee1c25"/></svg>',

  SI: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#fff"/>'
    + '<rect y="5" width="21" height="5" fill="#005da4"/>'
    + '<rect y="10" width="21" height="5" fill="#ed1c24"/></svg>',

  BE: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#fae042"/>'
    + '<rect width="7" height="15" fill="#000"/>'
    + '<rect x="14" width="7" height="15" fill="#ed2939"/></svg>',

  NL: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#fff"/>'
    + '<rect width="21" height="5" fill="#ae1c28"/>'
    + '<rect y="10" width="21" height="5" fill="#21468b"/></svg>',

  CH: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#da291c"/>'
    + '<rect x="9" y="3.3" width="3" height="8.4" fill="#fff"/>'
    + '<rect x="6.3" y="6" width="8.4" height="3" fill="#fff"/></svg>',

  NO: '<svg class="bans__flag" viewBox="0 0 21 15" aria-hidden="true" focusable="false">'
    + '<rect width="21" height="15" fill="#ba0c2f"/>'
    + '<rect x="6" width="3" height="15" fill="#fff"/>'
    + '<rect y="6" width="21" height="3" fill="#fff"/>'
    + '<rect x="7" width="1" height="15" fill="#00205b"/>'
    + '<rect y="7" width="21" height="1" fill="#00205b"/></svg>',
};

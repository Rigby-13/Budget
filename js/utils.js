// =====================================================================
// utils.js — мелкие полезные функции: форматирование денег и дат.
// =====================================================================

// Суммы храним в КОПЕЙКАХ (целые числа), чтобы не было ошибок
// округления вроде 0.1 + 0.2 = 0.30000000000000004.

const moneyFmt = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** 123450 (копеек) → "1 234,5 ₽" */
export function formatMoney(kopecks) {
  return moneyFmt.format(kopecks / 100);
}

/** Строка из поля ввода ("1 234,50") → копейки (123450) или NaN. */
export function parseMoney(text) {
  const clean = String(text).replace(/\s/g, '').replace(',', '.');
  if (!/^\d*\.?\d{0,2}$/.test(clean) || clean === '' || clean === '.') return NaN;
  return Math.round(parseFloat(clean) * 100);
}

/** Копейки → строка для поля ввода (123450 → "1234,5") */
export function moneyToInput(kopecks) {
  return String(kopecks / 100).replace('.', ',');
}

export const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** Date → 'ГГГГ-ММ-ДД' по местному времени. */
export function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'ГГГГ-ММ-ДД' → Date (местное время, полдень — чтобы не "съезжало"). */
export function fromISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

export function todayISO() {
  return toISODate(new Date());
}

/** Первый и последний день месяца в виде строк. */
export function monthRange(year, month) {
  const from = toISODate(new Date(year, month, 1));
  const to = toISODate(new Date(year, month + 1, 0));
  return { from, to };
}

/** Заголовок дня в списке: "Сегодня", "Вчера" или "8 ноября, вс". */
export function dayLabel(iso) {
  const today = todayISO();
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (iso === today) return 'Сегодня';
  if (iso === toISODate(y)) return 'Вчера';
  const d = fromISODate(iso);
  const yearPart = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${yearPart}, ${WEEKDAYS[d.getDay()]}`;
}

/** Защита от HTML в пользовательском тексте (комментарии, названия). */
export function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 'ГГГГ-ММ-ДД' → "15 ноября" (или "15 ноября 2025", если год другой). */
export function shortDate(iso) {
  const d = fromISODate(iso);
  const yearPart = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${yearPart}`;
}

/** Сколько дней от a до b (обе даты 'ГГГГ-ММ-ДД'). */
export function daysBetween(a, b) {
  return Math.round((fromISODate(b) - fromISODate(a)) / 86400000);
}

/** Правильное окончание: plural(3, 'день', 'дня', 'дней') → 'дня' */
export function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

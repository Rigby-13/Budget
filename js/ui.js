// =====================================================================
// ui.js — общие кусочки интерфейса: выезжающие панели, сообщения.
// =====================================================================

/** Короткая запись для document.getElementById */
export const $ = (id) => document.getElementById(id);

// Панели могут открываться одна поверх другой (например, из формы траты
// открыть список категорий, а из него — редактирование категории).
// Поэтому храним их стопкой: последняя открытая — сверху.
const stack = [];

function updateLayers() {
  stack.forEach((el, i) => { el.style.zIndex = 31 + i * 2; });
  const bd = $('backdrop');
  bd.classList.toggle('open', stack.length > 0);
  bd.style.zIndex = 30 + Math.max(0, stack.length - 1) * 2;
}

/** Открыть выезжающую панель (sheet) поверх остальных. */
export function openSheet(el) {
  if (!stack.includes(el)) stack.push(el);
  el.classList.add('open');
  el.querySelector('.sheet-body')?.scrollTo(0, 0);
  updateLayers();
}

/**
 * Поставить курсор в поле и открыть клавиатуру, не прокручивая страницу.
 * На iPhone это работает, только если вызвать прямо в обработчике нажатия.
 */
export function focusField(input) {
  const y = window.scrollY;
  input.focus({ preventScroll: true });
  // Подстраховка: если iPhone всё же прокрутил страницу — возвращаем на место
  setTimeout(() => {
    if (window.scrollY !== y) window.scrollTo(0, y);
    input.closest('.sheet-body')?.scrollTo(0, 0);
  }, 350);
}

/** Закрыть одну панель. */
export function closeSheet(el) {
  document.activeElement?.blur();
  el.classList.remove('open');
  const i = stack.indexOf(el);
  if (i >= 0) stack.splice(i, 1);
  updateLayers();
}

/** Закрыть верхнюю панель (нажатие на затемнённый фон). */
export function closeTopSheet() {
  if (stack.length) closeSheet(stack[stack.length - 1]);
}

/** Закрыть все открытые панели. */
export function closeSheets() {
  while (stack.length) closeSheet(stack[stack.length - 1]);
}

/** Открыта ли панель. */
export function isOpen(el) {
  return stack.includes(el);
}

/** Потрясти поле — если в нём ошибка. */
export function shake(el) {
  el.classList.remove('shake');
  void el.offsetWidth; // перезапуск анимации
  el.classList.add('shake');
}

let toastTimer;
/** Всплывающее сообщение внизу экрана. */
export function toast(text, ms = 2000) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

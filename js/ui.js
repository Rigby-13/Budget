// =====================================================================
// ui.js — общие кусочки интерфейса: выезжающие панели, сообщения.
// =====================================================================

/** Короткая запись для document.getElementById */
export const $ = (id) => document.getElementById(id);

/** Открыть выезжающую панель (sheet). */
export function openSheet(el) {
  $('backdrop').classList.add('open');
  el.classList.add('open');
  el.querySelector('.sheet-body')?.scrollTo(0, 0);
}

/** Закрыть все открытые панели. */
export function closeSheets() {
  document.activeElement?.blur();
  $('backdrop').classList.remove('open');
  for (const s of document.querySelectorAll('.sheet.open')) s.classList.remove('open');
}

/** Потрясти поле — если в нём ошибка. */
export function shake(el) {
  el.classList.remove('shake');
  void el.offsetWidth; // перезапуск анимации
  el.classList.add('shake');
}

let toastTimer;
/** Всплывающее сообщение внизу экрана. */
export function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

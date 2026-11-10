// =====================================================================
// theme.js — оформление: стиль (Классика / Лес / Огород) и тема
// (светлая / тёмная / как в системе). Сохраняется в localStorage.
//
// На <html> ставятся атрибуты:
//   data-style="classic | forest | garden"
//   data-theme="light | dark"   (для «как в системе» — по настройке iPhone)
// Цвета для каждого сочетания заданы в css/style.css.
// Чтобы не было «мигания» при запуске, то же самое делает маленький
// скрипт в <head> index.html ещё до загрузки стилей.
// =====================================================================

import { $ } from './ui.js';

export const STYLES = {
  classic: { name: 'Классика', swatch: ['#0a84ff', '#34c759', '#f5f5f7'] },
  forest: { name: 'Лес', swatch: ['#ff7a68', '#7fd1a6', '#10221a'] },
  garden: { name: 'Огород', swatch: ['#ff8a2b', '#5b78ff', '#b6e35a'] },
};
export const MODES = { light: 'Светлая', dark: 'Тёмная', system: 'Как в системе' };

const media = window.matchMedia('(prefers-color-scheme: dark)');

function read(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ничего */ }
}

export function getStyle() { return STYLES[read('uiStyle', 'classic')] ? read('uiStyle', 'classic') : 'classic'; }
export function getMode() { return MODES[read('uiMode', 'system')] ? read('uiMode', 'system') : 'system'; }

/** Применить выбранные стиль и тему к странице. */
export function applyTheme() {
  const mode = getMode();
  const dark = mode === 'dark' || (mode === 'system' && media.matches);
  const root = document.documentElement;
  root.dataset.style = getStyle();
  root.dataset.theme = dark ? 'dark' : 'light';
  // Цвет полоски статуса iPhone — как фон приложения
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim() || (dark ? '#000' : '#f5f5f7');
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.remove();
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = bg;
  document.head.appendChild(meta);
}

function renderPicker() {
  const style = getStyle(), mode = getMode();
  $('theme-styles').innerHTML = Object.entries(STYLES).map(([id, s]) => `
    <button type="button" class="style-opt ${id === style ? 'active' : ''}" data-style="${id}" aria-pressed="${id === style}">
      <span class="style-swatch" aria-hidden="true">${s.swatch.map((c) => `<i style="background:${c}"></i>`).join('')}</span>
      <span>${s.name}</span>
    </button>`).join('');
  for (const b of $('theme-modes').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.mode === mode);
  }
}

export function initTheme() {
  applyTheme();
  renderPicker();
  // «Как в системе»: следим за переключением темы на iPhone
  media.addEventListener('change', () => { if (getMode() === 'system') applyTheme(); });
  $('theme-styles').addEventListener('click', (e) => {
    const b = e.target.closest('[data-style]');
    if (!b) return;
    write('uiStyle', b.dataset.style);
    applyTheme();
    renderPicker();
    document.dispatchEvent(new Event('theme-changed'));
  });
  $('theme-modes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    write('uiMode', b.dataset.mode);
    applyTheme();
    renderPicker();
    document.dispatchEvent(new Event('theme-changed'));
  });
}

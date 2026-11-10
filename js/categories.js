// =====================================================================
// categories.js — свои категории: добавить, переименовать, сменить
// эмодзи, поменять порядок, удалить или скрыть.
//
// Категория в базе: { id, name, emoji, type: 'expense'|'income',
//                     order: номер по порядку, archived: скрыта ли }
// =====================================================================

import * as db from './db.js';
import { escapeHTML } from './utils.js';
import { $, focusField, openSheet, closeSheet, shake, toast, actionSheet } from './ui.js';

// Готовые эмодзи для быстрого выбора
const EMOJIS = [
  '🍔', '🛒', '☕', '🍕', '🍺', '🚌', '🚕', '🚗', '⛽', '✈️',
  '🏠', '💡', '🔧', '🛋️', '🧹', '🎉', '🎬', '🎮', '🎵', '📚',
  '👕', '👟', '💄', '💇', '💊', '🏥', '🏋️', '📱', '💻', '🌐',
  '🎁', '🐶', '👶', '🎓', '💳', '🏦', '📦', '💼', '💸', '💰',
  '📈', '🪙', '🧾', '🚬', '🌿', '🧸', '🏖️', '⚽', '🍷', '❤️',
];

const state = {
  type: 'expense',   // какие категории показываем: расходы или доходы
  editing: null,     // категория в форме редактирования (null — новая)
  selecting: false,  // режим «Выбрать» — галочки у строк
  selected: new Set(),
};

/** Сообщаем остальному приложению, что категории поменялись. */
function notifyChanged() {
  document.dispatchEvent(new Event('categories-changed'));
}

async function loadCategories(type) {
  const all = (await db.getAll('categories')).filter((c) => c.type === type);
  all.sort((a, b) => a.order - b.order);
  return {
    visible: all.filter((c) => !c.archived),
    hidden: all.filter((c) => c.archived),
  };
}

// =====================================================================
// СПИСОК КАТЕГОРИЙ
// =====================================================================
export async function openCategories(type = 'expense') {
  state.type = type;
  state.selecting = false;
  state.selected.clear();
  await renderList();
  openSheet($('cats-sheet'));
}

async function renderList() {
  for (const b of $('cats-type').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.type === state.type);
  }
  $('cats-select').textContent = state.selecting ? 'Отмена' : 'Выбрать';
  const { visible, hidden } = await loadCategories(state.type);

  const row = (c, isHidden) => `
    <div class="cat-row ${isHidden ? 'hidden-cat' : ''}" data-id="${c.id}">
      <div class="cat-swipe-bg"><span>Удалить</span><span>Удалить</span></div>
      <div class="cat-row-inner">
        ${state.selecting && !isHidden ? `<span class="cat-check ${state.selected.has(c.id) ? 'on' : ''}"></span>` : ''}
        <span class="tx-emoji">${c.emoji}</span>
        <span class="cat-row-name">${escapeHTML(c.name)}</span>
        ${isHidden || state.selecting ? '' : '<span class="drag-handle" aria-label="Перетащить">≡</span>'}
      </div>
    </div>`;

  let html = `<div class="day-list cat-list" id="cat-list-visible">${visible.map((c) => row(c, false)).join('')
    || '<div class="empty small">Категорий нет</div>'}</div>`;
  html += state.selecting
    ? `<button type="button" class="danger-fill full" id="cat-delete-selected" ${state.selected.size ? '' : 'disabled'}>
        ${state.selected.size ? `Удалить выбранные (${state.selected.size})` : 'Отметьте категории'}</button>`
    : `<button type="button" class="plain-btn add-cat" id="cat-add">＋ Новая категория</button>`;
  if (hidden.length && !state.selecting) {
    html += `<div class="section-title">Скрытые</div>
      <p class="small muted">Не видны при добавлении записи, но старые записи с ними сохранены. Нажмите, чтобы вернуть.</p>
      <div class="day-list">${hidden.map((c) => row(c, true)).join('')}</div>`;
  }
  $('cats-list').innerHTML = html;
}

/** Сохранить порядок по тому, как строки стоят на экране. */
async function saveOrderFromDom() {
  const ids = [...$('cat-list-visible').querySelectorAll('.cat-row')].map((r) => r.dataset.id);
  const all = await db.getAll('categories');
  for (let k = 0; k < ids.length; k++) {
    const c = all.find((x) => x.id === ids[k]);
    if (c && c.order !== k) await db.put('categories', { ...c, order: k });
  }
  notifyChanged();
}

// ---------------------------------------------------------------------
// Удаление: одной или нескольких категорий
// ---------------------------------------------------------------------
/** Категории с записями скрываем (записи остаются), остальные удаляем. */
async function removeCategories(ids) {
  const all = await db.getAll('categories');
  const tx = await db.getAll('transactions');
  let hiddenN = 0, deletedN = 0;
  for (const id of ids) {
    const c = all.find((x) => x.id === id);
    if (!c) continue;
    if (tx.some((t) => t.categoryId === id)) { await db.put('categories', { ...c, archived: true }); hiddenN++; }
    else { await db.remove('categories', id); deletedN++; }
  }
  const parts = [];
  if (deletedN) parts.push(`удалено: ${deletedN}`);
  if (hiddenN) parts.push(`скрыто (есть записи): ${hiddenN}`);
  toast(`Категории — ${parts.join(', ')}`, 3000);
  notifyChanged();
}

async function confirmRemove(ids, onCancel = () => {}) {
  const all = await db.getAll('categories');
  const tx = await db.getAll('transactions');
  const names = ids.map((id) => all.find((c) => c.id === id)).filter(Boolean);
  const used = names.filter((c) => tx.some((t) => t.categoryId === c.id));
  const title = names.length === 1 ? `«${names[0].emoji} ${names[0].name}»` : `${names.length} категорий`;
  const note = used.length
    ? (names.length === 1 ? ' С ней есть записи — категория будет скрыта, записи сохранятся.'
      : ` Категории с записями (${used.length}) будут скрыты, записи сохранятся.`)
    : '';
  let done = false;
  actionSheet(`<span class="as-danger">Удалить ${escapeHTML(title)}?${note}</span>`, [{
    label: names.length === 1 ? 'Удалить' : `Удалить ${names.length}`, danger: true,
    async onClick() { done = true; openRow = null; await removeCategories(ids); state.selected.clear(); state.selecting = false; await renderList(); },
  }]);
  // «Отмена» в меню — закрыть открытый свайп
  const cancel = $('action-sheet').querySelector('.as-cancel');
  cancel.addEventListener('click', () => { if (!done) onCancel(); }, { once: true });
}

// ---------------------------------------------------------------------
// Жесты: свайп — удалить, зажать и тащить — поменять порядок
// ---------------------------------------------------------------------
const OPEN = 96;          // насколько открывается кнопка «Удалить»
let suppressClickUntil = 0;
let openRow = null;       // строка с открытым свайпом
function closeOpenRow() {
  if (!openRow) return;
  const inner = openRow.querySelector('.cat-row-inner');
  inner.style.transition = 'transform 0.2s';
  inner.style.transform = '';
  openRow.classList.remove('open-left', 'open-right', 'swiping', 'swiping-right');
  openRow = null;
}

function initGestures() {
  const list = $('cats-list');
  let g = null; // текущий жест

  list.addEventListener('touchstart', (e) => {
    const row = e.target.closest('.cat-row');
    if (!row || row.classList.contains('hidden-cat') || state.selecting || e.touches.length > 1) return;
    const t = e.touches[0];
    const onHandle = !!e.target.closest('.drag-handle');
    g = { row, inner: row.querySelector('.cat-row-inner'), x0: t.clientX, y0: t.clientY, mode: null, dx: 0 };
    if (openRow && openRow !== row) closeOpenRow();
    // Ручка ≡ — тащим сразу; строка — после удержания
    if (onHandle) startDrag(g, t);
    else g.timer = setTimeout(() => { if (g && !g.mode) { startDrag(g, t); navigator.vibrate?.(10); } }, 350);
  }, { passive: true });

  list.addEventListener('touchmove', (e) => {
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x0, dy = t.clientY - g.y0;
    if (!g.mode) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { g.mode = 'swipe'; clearTimeout(g.timer); }
      else if (Math.abs(dy) > 10) { clearTimeout(g.timer); g = null; return; } // обычная прокрутка
      else return;
    }
    e.preventDefault();
    if (g.mode === 'swipe') {
      const base = g.row.classList.contains('open-right') ? OPEN : g.row.classList.contains('open-left') ? -OPEN : 0;
      g.dx = base + dx;
      g.inner.style.transition = 'none';
      g.inner.style.transform = `translateX(${g.dx}px)`;
      g.row.classList.add('swiping');
      g.row.classList.toggle('swiping-right', g.dx > 0);
    } else if (g.mode === 'drag') moveDrag(g, t);
  }, { passive: false });

  const end = () => {
    if (!g) return;
    clearTimeout(g.timer);
    if (g.mode === 'swipe') {
      const w = g.row.offsetWidth;
      g.inner.style.transition = 'transform 0.2s';
      if (Math.abs(g.dx) > w * 0.55) {
        // Длинный свайп — сразу удалить (с подтверждением)
        g.inner.style.transform = `translateX(${g.dx > 0 ? w : -w}px)`;
        const row = g.row;
        openRow = row;
        confirmRemove([row.dataset.id], closeOpenRow);
      } else if (Math.abs(g.dx) > 50) {
        g.inner.style.transform = `translateX(${g.dx > 0 ? OPEN : -OPEN}px)`;
        g.row.classList.toggle('open-right', g.dx > 0);
        g.row.classList.toggle('open-left', g.dx < 0);
        openRow = g.row;
      } else {
        openRow = g.row; closeOpenRow();
      }
      g.suppressClick = true;
    } else if (g.mode === 'drag') endDrag(g);
    // Окончание свайпа или перетаскивания — не нажатие на строку
    if (g.suppressClick || g.mode === 'drag') suppressClickUntil = Date.now() + 400;
    g = null;
  };
  list.addEventListener('touchend', end);
  list.addEventListener('touchcancel', end);
}

function startDrag(g, t) {
  g.mode = 'drag';
  g.startY = t.clientY;
  g.row.classList.add('dragging');
  g.list = g.row.parentElement;
}

function moveDrag(g, t) {
  const rows = [...g.list.querySelectorAll('.cat-row')];
  // Куда встать: сравниваем палец с серединами соседних строк
  for (const other of rows) {
    if (other === g.row) continue;
    const r = other.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    const before = g.row.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING;
    if (before && t.clientY > mid) { // тащим вниз через соседа
      const top = g.row.getBoundingClientRect().top;
      other.after(g.row);
      g.startY += g.row.getBoundingClientRect().top - top;
    } else if (!before && t.clientY < mid) { // вверх
      const top = g.row.getBoundingClientRect().top;
      other.before(g.row);
      g.startY += g.row.getBoundingClientRect().top - top;
    }
  }
  g.row.style.transform = `translateY(${t.clientY - g.startY}px)`;
}

async function endDrag(g) {
  g.row.style.transition = 'transform 0.15s';
  g.row.style.transform = '';
  setTimeout(() => { g.row.style.transition = ''; g.row.classList.remove('dragging'); }, 160);
  await saveOrderFromDom();
}

// =====================================================================
// ФОРМА: НОВАЯ КАТЕГОРИЯ / РЕДАКТИРОВАНИЕ
// =====================================================================
async function openEdit(cat = null) {
  state.editing = cat;
  $('cat-edit-title').textContent = cat ? 'Категория' : 'Новая категория';
  $('cat-name').value = cat ? cat.name : '';
  setEmoji(cat ? cat.emoji : EMOJIS[0]);
  $('cat-emoji-grid').innerHTML = EMOJIS.map((e) =>
    `<button type="button" class="emoji-btn" data-emoji="${e}">${e}</button>`).join('');
  markEmoji();

  $('cat-delete').hidden = !cat;
  $('cat-restore').hidden = !(cat && cat.archived);
  if (cat) {
    const used = await countUsage(cat.id);
    $('cat-delete').textContent = used ? 'Скрыть категорию' : 'Удалить категорию';
    $('cat-delete').hidden = !!cat.archived;
    $('cat-usage').textContent = used
      ? `Записей с этой категорией: ${used}`
      : 'Записей с этой категорией пока нет';
  } else {
    $('cat-usage').textContent = '';
  }

  openSheet($('cat-edit-sheet'));
  if (!cat) focusField($('cat-name'));
}

let currentEmoji = '';
function setEmoji(e) {
  currentEmoji = e;
  $('cat-emoji-preview').textContent = e;
  $('cat-emoji-input').value = '';
}
function markEmoji() {
  for (const b of $('cat-emoji-grid').querySelectorAll('.emoji-btn')) {
    b.classList.toggle('active', b.dataset.emoji === currentEmoji);
  }
}

/** Первый «символ» строки — с учётом эмодзи из нескольких частей (👨‍👩‍👧). */
function firstGrapheme(text) {
  text = text.trim();
  if (!text) return '';
  if (typeof Intl.Segmenter === 'function') {
    const seg = new Intl.Segmenter('ru', { granularity: 'grapheme' });
    return seg.segment(text)[Symbol.iterator]().next().value?.segment ?? '';
  }
  return Array.from(text)[0];
}

async function countUsage(categoryId) {
  const all = await db.getAll('transactions');
  return all.filter((t) => t.categoryId === categoryId).length;
}

async function saveCategory(e) {
  e.preventDefault();
  const name = $('cat-name').value.trim();
  if (!name) { shake($('cat-name')); $('cat-name').focus(); return; }

  const all = await db.getAll('categories');
  const duplicate = all.find((c) => c.type === state.type && !c.archived
    && c.name.toLowerCase() === name.toLowerCase() && c.id !== state.editing?.id);
  if (duplicate) { shake($('cat-name')); toast('Такая категория уже есть'); return; }

  // Лимит: пустое поле — без лимита
  const maxOrder = Math.max(-1, ...all.filter((c) => c.type === state.type).map((c) => c.order));
  const cat = state.editing
    ? { ...state.editing, name, emoji: currentEmoji }
    : { id: db.newId(), type: state.type, name, emoji: currentEmoji, order: maxOrder + 1, archived: false };
  await db.put('categories', cat);

  closeSheet($('cat-edit-sheet'));
  await renderList();
  notifyChanged();
  toast(state.editing ? 'Сохранено' : 'Категория добавлена');
}

async function deleteCategory() {
  const cat = state.editing;
  const used = await countUsage(cat.id);
  if (used) {
    if (!confirm(`С категорией «${cat.name}» есть записи (${used}).\n\n`
      + 'Категория будет скрыта из выбора, а старые записи останутся как есть.')) return;
    await db.put('categories', { ...cat, archived: true });
    toast('Категория скрыта');
  } else {
    if (!confirm(`Удалить категорию «${cat.name}»?`)) return;
    await db.remove('categories', cat.id);
    toast('Категория удалена');
  }
  closeSheet($('cat-edit-sheet'));
  await renderList();
  notifyChanged();
}

async function restoreCategory() {
  const all = await db.getAll('categories');
  const maxOrder = Math.max(-1, ...all.filter((c) => c.type === state.type && !c.archived).map((c) => c.order));
  await db.put('categories', { ...state.editing, archived: false, order: maxOrder + 1 });
  closeSheet($('cat-edit-sheet'));
  await renderList();
  notifyChanged();
  toast('Категория снова в списке');
}

// =====================================================================
// ОБРАБОТЧИКИ НАЖАТИЙ
// =====================================================================
export function initCategories() {
  $('cats-type').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.type = b.dataset.type;
    state.selected.clear();
    renderList();
  });

  $('cats-list').addEventListener('click', async (e) => {
    if (Date.now() < suppressClickUntil) return;
    if (e.target.closest('#cat-add')) { openEdit(null); return; }
    if (e.target.closest('#cat-delete-selected')) { confirmRemove([...state.selected]); return; }
    const row = e.target.closest('.cat-row');
    if (!row) return;
    // Нажали на открытую красную кнопку — удалить
    if (e.target.closest('.cat-swipe-bg')) { confirmRemove([row.dataset.id], closeOpenRow); return; }
    if (openRow) { closeOpenRow(); return; }
    if (state.selecting && !row.classList.contains('hidden-cat')) {
      const id = row.dataset.id;
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      renderList();
      return;
    }
    openEdit(await db.get('categories', row.dataset.id));
  });
  $('cats-select').addEventListener('click', () => {
    state.selecting = !state.selecting;
    state.selected.clear();
    closeOpenRow();
    renderList();
  });
  initGestures();

  $('cat-edit-sheet').addEventListener('submit', saveCategory);
  $('cat-emoji-grid').addEventListener('click', (e) => {
    const b = e.target.closest('.emoji-btn');
    if (!b) return;
    setEmoji(b.dataset.emoji);
    markEmoji();
  });
  // Можно вписать любой эмодзи с клавиатуры iPhone
  $('cat-emoji-input').addEventListener('input', (e) => {
    const g = firstGrapheme(e.target.value);
    if (!g) return;
    currentEmoji = g;
    $('cat-emoji-preview').textContent = g;
    markEmoji();
    e.target.value = ''; // поле снова пустое — выбранный эмодзи виден в большом квадрате
    e.target.blur();
  });
  $('cat-delete').addEventListener('click', deleteCategory);
  $('cat-restore').addEventListener('click', restoreCategory);
  $('settings-cats').addEventListener('click', () => openCategories('expense'));
}

// =====================================================================
// categories.js — свои категории: добавить, переименовать, сменить
// эмодзи, поменять порядок, удалить или скрыть.
//
// Категория в базе: { id, name, emoji, type: 'expense'|'income',
//                     order: номер по порядку, archived: скрыта ли }
// =====================================================================

import * as db from './db.js';
import { escapeHTML } from './utils.js';
import { $, openSheet, closeSheet, shake, toast } from './ui.js';

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
  await renderList();
  openSheet($('cats-sheet'));
}

async function renderList() {
  for (const b of $('cats-type').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.type === state.type);
  }
  const { visible, hidden } = await loadCategories(state.type);

  const row = (c, i, arr, isHidden) => `
    <div class="cat-row" data-id="${c.id}">
      <button type="button" class="cat-row-main" data-action="edit">
        <span class="tx-emoji">${c.emoji}</span>
        <span class="cat-row-name">${escapeHTML(c.name)}</span>
      </button>
      ${isHidden ? '' : `
        <button type="button" class="move-btn" data-action="up" ${i === 0 ? 'disabled' : ''} aria-label="Выше">↑</button>
        <button type="button" class="move-btn" data-action="down" ${i === arr.length - 1 ? 'disabled' : ''} aria-label="Ниже">↓</button>`}
    </div>`;

  let html = `<div class="day-list">${visible.map((c, i, a) => row(c, i, a, false)).join('')
    || '<div class="empty small">Категорий нет</div>'}</div>`;
  html += `<button type="button" class="plain-btn add-cat" id="cat-add">＋ Новая категория</button>`;
  if (hidden.length) {
    html += `<div class="section-title">Скрытые</div>
      <p class="small muted">Не видны при добавлении записи, но старые записи с ними сохранены.</p>
      <div class="day-list">${hidden.map((c, i, a) => row(c, i, a, true)).join('')}</div>`;
  }
  $('cats-list').innerHTML = html;
}

/** Поменять категорию местами с соседней (вверх или вниз). */
async function move(id, delta) {
  const { visible } = await loadCategories(state.type);
  const i = visible.findIndex((c) => c.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= visible.length) return;
  [visible[i], visible[j]] = [visible[j], visible[i]];
  // Перенумеровываем по порядку
  for (let k = 0; k < visible.length; k++) {
    if (visible[k].order !== k) await db.put('categories', { ...visible[k], order: k });
  }
  await renderList();
  notifyChanged();
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
  if (!cat) $('cat-name').focus();
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
    renderList();
  });

  $('cats-list').addEventListener('click', async (e) => {
    if (e.target.closest('#cat-add')) { openEdit(null); return; }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.closest('.cat-row').dataset.id;
    const action = btn.dataset.action;
    if (action === 'up') move(id, -1);
    else if (action === 'down') move(id, 1);
    else openEdit(await db.get('categories', id));
  });

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
  });
  $('cat-delete').addEventListener('click', deleteCategory);
  $('cat-restore').addEventListener('click', restoreCategory);
  $('settings-cats').addEventListener('click', () => openCategories('expense'));
}

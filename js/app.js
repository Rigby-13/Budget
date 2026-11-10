// =====================================================================
// app.js — главная логика приложения: запуск, вкладки, траты.
// =====================================================================

import * as db from './db.js';
import {
  formatMoney, parseMoney, moneyToInput, MONTHS, todayISO,
  monthRange, dayLabel, escapeHTML,
} from './utils.js';
import { $, openSheet, closeSheet, closeSheets, closeTopSheet, isOpen, shake, toast } from './ui.js';
import { initCategories, openCategories } from './categories.js';
import { initDebts, renderDebts, openDebtSheet } from './debts.js';
import { initBackup, openSettings } from './backup.js';

// ---------- Категории по умолчанию (создаются при первом запуске) ----------
const DEFAULT_CATEGORIES = [
  ['🍔', 'Еда', 'expense'], ['🚌', 'Транспорт', 'expense'],
  ['🏠', 'Жильё', 'expense'], ['🎉', 'Развлечения', 'expense'],
  ['👕', 'Одежда', 'expense'], ['💊', 'Здоровье', 'expense'],
  ['📱', 'Связь', 'expense'], ['🎁', 'Подарки', 'expense'],
  ['📦', 'Другое', 'expense'],
  ['💼', 'Зарплата', 'income'], ['💸', 'Подработка', 'income'],
  ['🎁', 'Подарок', 'income'], ['📦', 'Другое', 'income'],
];

// ---------- Состояние приложения ----------
const now = new Date();
const state = {
  year: now.getFullYear(),
  month: now.getMonth(),     // 0 = январь
  categories: [],            // все категории
  editing: null,             // запись, которую редактируем (или null для новой)
  formType: 'expense',       // 'expense' или 'income' в форме
  formCategoryId: null,      // выбранная категория в форме
  view: 'expenses',          // текущая вкладка
};

// =====================================================================
// ЗАПУСК
// =====================================================================
async function init() {
  await db.openDB();
  await seedCategories();
  state.categories = await db.getAll('categories');

  // Просим браузер не удалять наши данные при нехватке места
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

  bindEvents();
  initDebts();
  initBackup();
  initCategories();
  await renderExpenses();
}

async function seedCategories() {
  const existing = await db.getAll('categories');
  if (existing.length) return;
  let order = 0;
  for (const [emoji, name, type] of DEFAULT_CATEGORIES) {
    await db.put('categories', { id: db.newId(), emoji, name, type, order: order++ });
  }
}

function categoriesOf(type) {
  return state.categories
    .filter((c) => c.type === type && !c.archived)
    .sort((a, b) => a.order - b.order);
}

function categoryById(id) {
  return state.categories.find((c) => c.id === id) || { emoji: '❔', name: 'Без категории' };
}

// =====================================================================
// ВКЛАДКА «ТРАТЫ»: итоги месяца и список
// =====================================================================
async function renderExpenses() {
  $('month-title').textContent = `${MONTHS[state.month]} ${state.year}`;

  const { from, to } = monthRange(state.year, state.month);
  const items = await db.getTransactionsBetween(from, to);

  // Итоги
  let expense = 0, income = 0;
  for (const t of items) {
    if (t.type === 'income') income += t.amount; else expense += t.amount;
  }
  const balance = income - expense;
  $('sum-expense').textContent = formatMoney(expense);
  $('sum-income').textContent = formatMoney(income);
  $('sum-balance').textContent = (balance > 0 ? '+' : '') + formatMoney(balance);

  // Сортировка: новые сверху
  items.sort((a, b) => (b.date.localeCompare(a.date)) || (b.createdAt - a.createdAt));

  const list = $('tx-list');
  if (!items.length) {
    list.innerHTML = `<div class="empty">В этом месяце пока нет записей.<br>Нажмите «+», чтобы добавить первую трату.</div>`;
    return;
  }

  // Группируем по дням
  const groups = new Map();
  for (const t of items) {
    if (!groups.has(t.date)) groups.set(t.date, []);
    groups.get(t.date).push(t);
  }

  let html = '';
  for (const [date, txs] of groups) {
    const dayExpense = txs.filter((t) => t.type !== 'income').reduce((s, t) => s + t.amount, 0);
    html += `<section class="day-group">
      <div class="day-head"><span>${dayLabel(date)}</span><span>${dayExpense ? '−' + formatMoney(dayExpense) : ''}</span></div>
      <div class="day-list">`;
    for (const t of txs) {
      const c = categoryById(t.categoryId);
      const sign = t.type === 'income' ? '+' : '−';
      html += `<button class="tx" data-id="${t.id}">
          <span class="tx-emoji">${c.emoji}</span>
          <span class="tx-main">
            <div class="tx-cat">${escapeHTML(c.name)}</div>
            ${t.comment ? `<div class="tx-comment">${escapeHTML(t.comment)}</div>` : ''}
          </span>
          <span class="tx-amount ${t.type === 'income' ? 'income' : ''}">${sign}${formatMoney(t.amount)}</span>
        </button>`;
    }
    html += `</div></section>`;
  }
  list.innerHTML = html;
}

function shiftMonth(delta) {
  const d = new Date(state.year, state.month + delta, 1);
  state.year = d.getFullYear();
  state.month = d.getMonth();
  renderExpenses();
}

// =====================================================================
// ФОРМА ДОБАВЛЕНИЯ / РЕДАКТИРОВАНИЯ
// =====================================================================
function openTxSheet(tx = null) {
  state.editing = tx;
  state.formType = tx ? tx.type : 'expense';
  state.formCategoryId = tx ? tx.categoryId : lastCategory(state.formType);

  $('tx-amount').value = tx ? moneyToInput(tx.amount) : '';
  $('tx-date').value = tx ? tx.date : todayISO();
  $('tx-comment').value = tx ? tx.comment || '' : '';
  $('tx-delete').hidden = !tx;

  renderTypeToggle();
  renderCategoryChips();

  openSheet($('tx-sheet'));

  // Для новой записи сразу открываем клавиатуру с цифрами.
  // На iPhone focus() работает только прямо внутри обработчика нажатия.
  if (!tx) $('tx-amount').focus();
}

function closeTxSheet() {
  closeSheets();
  state.editing = null;
}

function renderTypeToggle() {
  for (const b of $('tx-type').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.type === state.formType);
  }
}

function renderCategoryChips() {
  const cats = categoriesOf(state.formType);
  // Если редактируем старую запись со скрытой категорией — показываем и её,
  // чтобы категория записи случайно не поменялась
  const current = state.categories.find((c) => c.id === state.editing?.categoryId);
  if (current && current.archived && current.type === state.formType) cats.push(current);

  if (!cats.some((c) => c.id === state.formCategoryId)) {
    state.formCategoryId = cats[0]?.id ?? null;
  }
  $('tx-categories').innerHTML = cats.map((c) => `
    <button type="button" class="cat-chip ${c.id === state.formCategoryId ? 'active' : ''}" data-id="${c.id}">
      <span class="e">${c.emoji}</span><span class="n">${escapeHTML(c.name)}</span>
    </button>`).join('') + `
    <button type="button" class="cat-chip cat-edit" data-edit="1">
      <span class="e">✏️</span><span class="n">Изменить</span>
    </button>`;
}

// Запоминаем последнюю использованную категорию — чтобы добавлять быстрее
function lastCategory(type) {
  try { return localStorage.getItem('lastCat:' + type); } catch { return null; }
}
function rememberCategory(type, id) {
  try { localStorage.setItem('lastCat:' + type, id); } catch { /* не страшно */ }
}

async function saveForm(e) {
  e.preventDefault();
  const amount = parseMoney($('tx-amount').value);
  if (!amount || amount <= 0) {
    shake($('tx-amount'));
    $('tx-amount').focus();
    return;
  }
  if (!state.formCategoryId) { toast('Выберите категорию'); return; }

  const date = $('tx-date').value || todayISO();
  const tx = {
    id: state.editing?.id ?? db.newId(),
    createdAt: state.editing?.createdAt ?? Date.now(),
    type: state.formType,
    amount,
    categoryId: state.formCategoryId,
    date,
    comment: $('tx-comment').value.trim(),
  };
  await db.put('transactions', tx);
  rememberCategory(tx.type, tx.categoryId);

  const wasEditing = !!state.editing;
  closeTxSheet();

  // Если запись в другом месяце — переключаемся на него, чтобы её было видно
  const [y, m] = date.split('-').map(Number);
  state.year = y; state.month = m - 1;
  await renderExpenses();
  toast(wasEditing ? 'Сохранено' : 'Добавлено');
}

async function deleteCurrent() {
  if (!state.editing) return;
  if (!confirm('Удалить эту запись?')) return;
  await db.remove('transactions', state.editing.id);
  closeTxSheet();
  await renderExpenses();
  toast('Удалено');
}

// =====================================================================
// МЕЛОЧИ ИНТЕРФЕЙСА
// =====================================================================
function switchView(name) {
  state.view = name;
  for (const v of document.querySelectorAll('.view')) {
    v.classList.toggle('active', v.id === 'view-' + name);
  }
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('active', t.dataset.view === name);
  }
  // Кнопка «+» есть на вкладках трат и долгов
  $('fab').classList.toggle('hidden', !['expenses', 'debts'].includes(name));
  if (name === 'debts') renderDebts();
  window.scrollTo(0, 0);
}

// =====================================================================
// ОБРАБОТЧИКИ НАЖАТИЙ
// =====================================================================
function bindEvents() {
  // «+» добавляет то, что относится к открытой вкладке
  $('fab').addEventListener('click', () => {
    if (state.view === 'debts') openDebtSheet();
    else openTxSheet();
  });
  for (const b of document.querySelectorAll('.settings-btn')) {
    b.addEventListener('click', openSettings);
  }
  $('prev-month').addEventListener('click', () => shiftMonth(-1));
  $('next-month').addEventListener('click', () => shiftMonth(1));

  $('tx-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.tx');
    if (!btn) return;
    const tx = await db.get('transactions', btn.dataset.id);
    if (tx) openTxSheet(tx);
  });

  $('tx-cancel').addEventListener('click', closeTxSheet);
  $('backdrop').addEventListener('click', closeTopSheet);
  // Кнопки с атрибутом data-close закрывают свою панель
  for (const b of document.querySelectorAll('[data-close]')) {
    b.addEventListener('click', () => closeSheet(b.closest('.sheet')));
  }

  // Категории изменились (в настройках) — перечитываем и перерисовываем
  document.addEventListener('categories-changed', async () => {
    state.categories = await db.getAll('categories');
    if (isOpen($('tx-sheet'))) renderCategoryChips();
    await renderExpenses();
  });
  $('tx-sheet').addEventListener('submit', saveForm);
  $('tx-delete').addEventListener('click', deleteCurrent);

  $('tx-type').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.formType = b.dataset.type;
    state.formCategoryId = lastCategory(state.formType);
    renderTypeToggle();
    renderCategoryChips();
  });

  $('tx-categories').addEventListener('click', (e) => {
    const b = e.target.closest('.cat-chip');
    if (!b) return;
    if (b.dataset.edit) { openCategories(state.formType); return; }
    state.formCategoryId = b.dataset.id;
    renderCategoryChips();
  });

  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => switchView(t.dataset.view));
  }
}

// Service worker — нужен для работы без интернета.
// Регистрируем его ДО запуска, чтобы обновление пришло, даже если в
// приложении что-то сломалось.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW:', e));
  // Пришла новая версия — один раз перезагружаемся, чтобы сразу её показать
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
}

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin',
    `<div class="empty">Ошибка запуска: ${escapeHTML(err.message)}</div>`);
});

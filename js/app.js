// =====================================================================
// app.js — главная логика приложения: запуск, вкладки, траты.
// =====================================================================

import * as db from './db.js';
import {
  formatMoney, parseMoney, moneyToInput, MONTHS, todayISO, now,
  monthRange, dayLabel, escapeHTML,
} from './utils.js';
import { $, focusField, openSheet, closeSheet, closeSheets, closeTopSheet, isOpen, shake, toast } from './ui.js';
import { initCategories, openCategories } from './categories.js';
import { initDebts, renderDebts, openDebtSheet } from './debts.js';
import { initBackup, renderSettings } from './backup.js';
import { initStats, renderStats } from './stats.js';
import { migrateOldLimits, migratePlansToTemplates, refreshCurrentSnapshot } from './plan.js';
import {
  initLimitForm, showLimitForm, saveLimitForm, renderPlanCard, planToastAfterSave, BUDGET,
  initTemplatesSettings, renderTemplatesSettings,
} from './planui.js';
import { initTestMode } from './testmode.js';
import { initSavings } from './savings.js';

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
const today = now();
const state = {
  year: today.getFullYear(),
  month: today.getMonth(),   // 0 = январь
  categories: [],            // все категории
  editing: null,             // запись, которую редактируем (или null для новой)
  formType: 'expense',       // 'expense', 'income' или 'limit' в форме
  formCategoryId: null,      // выбранная категория в форме
  view: 'expenses',          // текущая вкладка
  dailyIds: [],              // категории с дневным лимитом — первые в «+»
};

// =====================================================================
// ЗАПУСК
// =====================================================================
async function init() {
  await db.openDB();
  await seedCategories();
  await migrateOldLimits();
  await migratePlansToTemplates();
  await refreshCurrentSnapshot(); // запоминаем план текущего месяца на будущее
  state.categories = await db.getAll('categories');

  // Просим браузер не удалять наши данные при нехватке места
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

  bindEvents();
  initDebts();
  initBackup();
  initCategories();
  initStats();
  initLimitForm();
  initTemplatesSettings();
  initSavings();
  initTestMode();
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
  // Категории с дневным лимитом — первыми, остальные — в вашем порядке
  const rank = (c) => (state.dailyIds.includes(c.id) ? 0 : 1);
  return state.categories
    .filter((c) => c.type === type && !c.archived)
    .sort((a, b) => rank(a) - rank(b) || a.order - b.order);
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

  // План на месяц: лимиты на сегодня, перенос, итоги прошлого месяца
  state.dailyIds = await renderPlanCard(viewKey(), items);
  renderDetails(expense);

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

/** 'ГГГГ-ММ' месяца, открытого на экране «Траты». */
function viewKey() {
  return `${state.year}-${String(state.month + 1).padStart(2, '0')}`;
}

// Секция «План и итоги месяца»: в текущем месяце свёрнута (по выбору),
// в прошлых месяцах всегда открыта — там «Сегодня можно» не нужно.
function detailsOpen() {
  try { return localStorage.getItem('detailsOpen') === '1'; } catch { return false; }
}
function renderDetails(expense) {
  const n = now();
  const isCurrent = state.year === n.getFullYear() && state.month === n.getMonth();
  const open = !isCurrent || detailsOpen();
  $('details-toggle').hidden = !isCurrent;
  $('details-body').hidden = !open;
  $('details-toggle').setAttribute('aria-expanded', String(open));
  $('month-details').classList.toggle('open', open);
  $('details-hint').textContent = open ? '' : `расходы ${formatMoney(expense)}`;
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
/**
 * Открыть окно «+». tx — запись для редактирования.
 * limitFor — сразу открыть вкладку «Лимит» (id категории или BUDGET).
 */
function openTxSheet(tx = null, limitFor = null, categoryId = null, limitMonth = null) {
  state.editing = tx;
  state.formType = limitFor ? 'limit' : tx ? tx.type : 'expense';
  state.formCategoryId = tx ? tx.categoryId : categoryId || lastCategory(state.formType);

  $('tx-amount').value = tx ? moneyToInput(tx.amount) : '';
  $('tx-date').value = tx ? tx.date : todayISO();
  $('tx-comment').value = tx ? tx.comment || '' : '';
  $('tx-delete').hidden = !tx;
  // Дату и комментарий показываем сразу, только если они уже заполнены
  setExtraOpen(!!tx && (tx.date !== todayISO() || !!tx.comment));

  renderTypeToggle();
  if (limitFor) showLimitForm(limitFor === BUDGET ? BUDGET : limitFor, limitMonth || viewKey());
  else renderCategoryChips();

  openSheet($('tx-sheet'));

  // Для новой записи сразу открываем клавиатуру с цифрами.
  // На iPhone focus() работает только прямо внутри обработчика нажатия.
  if (!tx) focusField($('tx-amount'));
}

function closeTxSheet() {
  closeSheets();
  state.editing = null;
}

function renderTypeToggle() {
  for (const b of $('tx-type').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.type === state.formType);
  }
  // Вкладку «Лимит» нельзя выбрать при редактировании записи
  $('tx-type').querySelector('[data-type=limit]').hidden = !!state.editing;
  const isLimit = state.formType === 'limit';
  $('tx-categories').hidden = isLimit;
  $('tx-fields').hidden = isLimit;
  $('limit-fields').hidden = !isLimit;
  $('plan-picker').hidden = !isLimit;
  $('amount-caption').hidden = !isLimit;
  $('tx-delete').hidden = isLimit || !state.editing;
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

function setExtraOpen(open) {
  $('tx-extra').hidden = !open;
  $('tx-more').hidden = open;
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
  if (state.formType === 'limit') {
    if (await saveLimitForm()) {
      closeTxSheet();
      document.dispatchEvent(new Event('plan-changed'));
    }
    return;
  }
  const amount = parseMoney($('tx-amount').value);
  if (!amount || amount <= 0) {
    shake($('tx-amount'));
    $('tx-amount').focus({ preventScroll: true });
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
  const before = state.editing ? { ...state.editing } : null;
  closeTxSheet();

  // Если запись в другом месяце — переключаемся на него, чтобы её было видно
  const [y, m] = date.split('-').map(Number);
  state.year = y; state.month = m - 1;
  await renderExpenses();
  // Кнопка «Отменить»: удаляет новую запись или возвращает старую версию
  const undo = {
    label: 'Отменить',
    async onClick() {
      if (before) await db.put('transactions', before);
      else await db.remove('transactions', tx.id);
      await renderExpenses();
      toast('Отменено');
    },
  };
  // Если у категории есть лимит — покажем остаток вместо «Добавлено»
  if (!(await planToastAfterSave(tx, undo))) toast(wasEditing ? 'Сохранено' : 'Добавлено', 4000, undo);
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
  if (name === 'stats') renderStats();
  if (name === 'settings') { renderSettings(); renderTemplatesSettings(); }
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
    if (state.view === 'stats') await renderStats();
  });
  $('tx-sheet').addEventListener('submit', saveForm);
  $('tx-delete').addEventListener('click', deleteCurrent);

  $('tx-type').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.type === state.formType) return;
    const wasLimit = state.formType === 'limit';
    state.formType = b.dataset.type;
    renderTypeToggle();
    if (state.formType === 'limit') { showLimitForm(null, viewKey()); return; }
    if (wasLimit) $('tx-amount').value = '';
    state.formCategoryId = lastCategory(state.formType);
    renderCategoryChips();
  });

  // Нажатие на строку плана / кнопку «Изменить» — открыть вкладку «Лимит».
  // Нажатие на «Сегодня можно» — сразу записать трату в эту категорию.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-plan-edit]');
    if (b) { openTxSheet(null, b.dataset.planEdit, null, b.dataset.planMonth || null); return; }
    const q = e.target.closest('[data-quick-add]');
    if (q) openTxSheet(null, null, q.dataset.quickAdd || null);
  });

  $('details-toggle').addEventListener('click', () => {
    const open = $('details-body').hidden;
    try { localStorage.setItem('detailsOpen', open ? '1' : '0'); } catch { /* ничего */ }
    renderDetails(0);
    renderExpenses();
  });

  $('tx-more').addEventListener('click', () => setExtraOpen(true));

  // Копилка изменилась — обновляем итоги месяца и раздел «Накопления»
  document.addEventListener('savings-changed', async () => {
    await renderExpenses();
    if (state.view === 'stats') await renderStats();
  });

  // План изменился — перерисовываем
  document.addEventListener('plan-changed', async () => {
    await renderExpenses();
    if (state.view === 'settings') await renderTemplatesSettings();
    if (state.view === 'stats') await renderStats();
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

// =====================================================================
// debts.js — вкладка «Долги».
//
// Как устроен долг (запись в таблице debts):
// {
//   id, direction: 'owed' (мне должны) или 'owe' (я должен),
//   person: 'Кто', amount: сумма в копейках,
//   date: 'когда взял', dueDate: 'срок возврата' или '',
//   comment, payments: [{ id, amount, date }],
//   closed: true/false, closedAt: 'дата закрытия'
// }
// =====================================================================

import * as db from './db.js';
import {
  formatMoney, parseMoney, moneyToInput, todayISO,
  shortDate, daysBetween, plural, escapeHTML,
} from './utils.js';
import { $, openSheet, closeSheets, shake, toast } from './ui.js';

const state = {
  filter: 'active',     // 'active' или 'closed'
  editing: null,        // долг, открытый в панели (или null — новый)
  direction: 'owed',    // направление в форме
};

/** Сколько уже вернули и сколько осталось. */
function paidOf(debt) {
  return (debt.payments || []).reduce((s, p) => s + p.amount, 0);
}
function remainingOf(debt) {
  return Math.max(0, debt.amount - paidOf(debt));
}

// =====================================================================
// СПИСОК
// =====================================================================
export async function renderDebts() {
  const all = await db.getAll('debts');
  const active = all.filter((d) => !d.closed);

  // Итоги по активным долгам
  const sum = (dir) => active.filter((d) => d.direction === dir)
    .reduce((s, d) => s + remainingOf(d), 0);
  $('debt-owed-total').textContent = formatMoney(sum('owed'));
  $('debt-owe-total').textContent = formatMoney(sum('owe'));

  for (const b of $('debt-filter').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.filter === state.filter);
  }

  const list = $('debt-list');
  const shown = state.filter === 'active' ? active : all.filter((d) => d.closed);

  if (!shown.length) {
    list.innerHTML = state.filter === 'active'
      ? `<div class="empty">Активных долгов нет 🎉<br>Нажмите «+», чтобы записать долг.</div>`
      : `<div class="empty">Закрытых долгов пока нет.</div>`;
    return;
  }

  const today = todayISO();
  if (state.filter === 'active') {
    // Сначала просроченные, потом по сроку возврата, без срока — в конце
    shown.sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')
      || a.date.localeCompare(b.date));
  } else {
    shown.sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || ''));
  }

  const section = (dir, title) => {
    const items = shown.filter((d) => d.direction === dir);
    if (!items.length) return '';
    return `<section class="day-group">
      <div class="day-head"><span>${title}</span></div>
      <div class="day-list">${items.map((d) => debtRow(d, today)).join('')}</div>
    </section>`;
  };
  list.innerHTML = section('owed', 'Мне должны') + section('owe', 'Я должен');
}

function debtRow(d, today) {
  const paid = paidOf(d);
  const remaining = remainingOf(d);
  const pct = d.amount ? Math.min(100, Math.round((paid / d.amount) * 100)) : 0;

  let meta = `с ${shortDate(d.date)}`;
  let metaClass = '';
  if (d.closed) {
    meta = `закрыт ${d.closedAt ? shortDate(d.closedAt) : ''}`;
  } else if (d.dueDate) {
    const left = daysBetween(today, d.dueDate);
    if (left < 0) {
      meta = `просрочен на ${-left} ${plural(-left, 'день', 'дня', 'дней')}`;
      metaClass = 'overdue';
    } else if (left === 0) {
      meta = 'вернуть сегодня'; metaClass = 'soon';
    } else {
      meta = `вернуть до ${shortDate(d.dueDate)}`;
      if (left <= 3) metaClass = 'soon';
    }
  }

  return `<button class="tx debt-item" data-id="${d.id}">
    <span class="tx-emoji">${d.direction === 'owed' ? '📥' : '📤'}</span>
    <span class="tx-main">
      <div class="tx-cat">${escapeHTML(d.person)}</div>
      <div class="tx-comment ${metaClass}">${meta}${d.comment ? ' · ' + escapeHTML(d.comment) : ''}</div>
      ${paid > 0 && !d.closed ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ''}
    </span>
    <span class="tx-amount ${d.direction === 'owed' ? 'income' : 'owe'}">
      ${formatMoney(d.closed ? d.amount : remaining)}
      ${paid > 0 && !d.closed ? `<small>из ${formatMoney(d.amount)}</small>` : ''}
    </span>
  </button>`;
}

// =====================================================================
// ПАНЕЛЬ: НОВЫЙ ДОЛГ / ПРОСМОТР И РЕДАКТИРОВАНИЕ
// =====================================================================
export async function openDebtSheet(debt = null) {
  state.editing = debt;
  state.direction = debt ? debt.direction : 'owed';

  $('debt-amount').value = debt ? moneyToInput(debt.amount) : '';
  $('debt-person').value = debt ? debt.person : '';
  $('debt-date').value = debt ? debt.date : todayISO();
  $('debt-due').value = debt ? debt.dueDate || '' : '';
  $('debt-comment').value = debt ? debt.comment || '' : '';

  renderDirection();
  renderExtra();
  await fillPeopleList();
  openSheet($('debt-sheet'));
  if (!debt) $('debt-amount').focus();
}

function renderDirection() {
  for (const b of $('debt-direction').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.dir === state.direction);
  }
}

/** Подсказки с именами, которые уже встречались. */
async function fillPeopleList() {
  const names = [...new Set((await db.getAll('debts')).map((d) => d.person))].sort();
  $('people-list').innerHTML = names.map((n) => `<option value="${escapeHTML(n)}">`).join('');
}

/** Блок погашений — виден только у существующего долга. */
function renderExtra() {
  const d = state.editing;
  $('debt-extra').hidden = !d;
  if (!d) return;

  const paid = paidOf(d);
  const remaining = remainingOf(d);
  const pct = d.amount ? Math.min(100, Math.round((paid / d.amount) * 100)) : 0;

  $('debt-status').innerHTML = d.closed
    ? `Долг закрыт${d.closedAt ? ' ' + shortDate(d.closedAt) : ''} ✅`
    : `Осталось <b>${formatMoney(remaining)}</b> из ${formatMoney(d.amount)}`;
  $('debt-progress').style.width = (d.closed ? 100 : pct) + '%';

  const pays = [...(d.payments || [])].sort((a, b) => b.date.localeCompare(a.date));
  $('pay-list').innerHTML = pays.length
    ? pays.map((p) => `<div class="pay-row">
        <span>${shortDate(p.date)}</span>
        <b>${formatMoney(p.amount)}</b>
        <button type="button" class="pay-del" data-id="${p.id}" aria-label="Удалить погашение">✕</button>
      </div>`).join('')
    : `<div class="muted small">Погашений пока не было</div>`;

  $('pay-form').hidden = d.closed;
  $('pay-amount').value = '';
  $('pay-date').value = todayISO();
  $('debt-toggle').textContent = d.closed ? 'Вернуть в активные' : 'Отметить закрытым';
}

/** Кнопка «Готово» — сохраняем основные поля долга. */
async function saveDebt(e) {
  e.preventDefault();
  const amount = parseMoney($('debt-amount').value);
  if (!amount || amount <= 0) { shake($('debt-amount')); $('debt-amount').focus(); return; }
  const person = $('debt-person').value.trim();
  if (!person) { shake($('debt-person')); $('debt-person').focus(); return; }

  // Берём свежую версию из базы, чтобы не потерять погашения
  const old = state.editing ? await db.get('debts', state.editing.id) : null;
  const debt = {
    ...(old || { id: db.newId(), createdAt: Date.now(), payments: [], closed: false, closedAt: '' }),
    direction: state.direction,
    amount,
    person,
    date: $('debt-date').value || todayISO(),
    dueDate: $('debt-due').value || '',
    comment: $('debt-comment').value.trim(),
  };
  await db.put('debts', debt);
  closeSheets();
  if (!old) state.filter = 'active';
  await renderDebts();
  toast(old ? 'Сохранено' : 'Долг записан');
}

/** Кнопка «Внести» — частичное погашение. */
async function addPayment() {
  const d = await db.get('debts', state.editing.id);
  const amount = parseMoney($('pay-amount').value);
  const remaining = remainingOf(d);
  if (!amount || amount <= 0) { shake($('pay-amount')); return; }
  if (amount > remaining) {
    shake($('pay-amount'));
    toast(`Осталось только ${formatMoney(remaining)}`);
    return;
  }
  d.payments = [...(d.payments || []), { id: db.newId(), amount, date: $('pay-date').value || todayISO() }];

  if (remainingOf(d) === 0) {
    d.closed = true;
    d.closedAt = todayISO();
    toast('Долг погашен полностью 🎉');
  } else {
    toast('Погашение записано');
  }
  await db.put('debts', d);
  state.editing = d;
  document.activeElement?.blur();
  renderExtra();
  await renderDebts();
}

async function deletePayment(paymentId) {
  if (!confirm('Удалить это погашение?')) return;
  const d = await db.get('debts', state.editing.id);
  d.payments = (d.payments || []).filter((p) => p.id !== paymentId);
  await db.put('debts', d);
  state.editing = d;
  renderExtra();
  await renderDebts();
}

async function toggleClosed() {
  const d = await db.get('debts', state.editing.id);
  d.closed = !d.closed;
  d.closedAt = d.closed ? todayISO() : '';
  await db.put('debts', d);
  closeSheets();
  await renderDebts();
  toast(d.closed ? 'Долг закрыт' : 'Долг снова активен');
}

async function deleteDebt() {
  if (!confirm('Удалить долг вместе с историей погашений?')) return;
  await db.remove('debts', state.editing.id);
  closeSheets();
  await renderDebts();
  toast('Удалено');
}

// =====================================================================
// ОБРАБОТЧИКИ НАЖАТИЙ
// =====================================================================
export function initDebts() {
  $('debt-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.filter = b.dataset.filter;
    renderDebts();
  });

  $('debt-list').addEventListener('click', async (e) => {
    const row = e.target.closest('.debt-item');
    if (!row) return;
    const d = await db.get('debts', row.dataset.id);
    if (d) openDebtSheet(d);
  });

  $('debt-direction').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.direction = b.dataset.dir;
    renderDirection();
  });

  $('debt-cancel').addEventListener('click', closeSheets);
  $('debt-sheet').addEventListener('submit', saveDebt);
  $('pay-add').addEventListener('click', addPayment);
  // Enter в поле погашения — вносим погашение, а не сохраняем всю форму
  $('pay-amount').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addPayment(); }
  });
  $('pay-all').addEventListener('click', async () => {
    const d = await db.get('debts', state.editing.id);
    $('pay-amount').value = moneyToInput(remainingOf(d));
  });
  $('pay-list').addEventListener('click', (e) => {
    const b = e.target.closest('.pay-del');
    if (b) deletePayment(b.dataset.id);
  });
  $('debt-toggle').addEventListener('click', toggleClosed);
  $('debt-delete').addEventListener('click', deleteDebt);
}

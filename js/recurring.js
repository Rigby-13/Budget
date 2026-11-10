// =====================================================================
// recurring.js — регулярные платежи (подписки, связь, проездной…).
//
// Платёж хранится в таблице settings:
// { id: 'rec:…', name: 'МТС', type: 'expense'|'income', amount (копейки),
//   categoryId, kind: 'month'|'week'|'days'|'year',
//   day (число месяца, для month), weekday (0 — пн … 6 — вс, для week),
//   every (каждые N дней, для days), start: 'ГГГГ-ММ-ДД', end: '' | 'ГГГГ-ММ-ДД',
//   askAmount: спрашивать сумму, lastRun: по какой день уже обработан,
//   pending: ['ГГГГ-ММ-ДД', …] — ждут подтверждения суммы, createdAt }
//
// Приложение работает без сервера, поэтому платежи вносятся при открытии:
// всё, что подошло с прошлого раза, добавляется датой самого платежа.
// Записи из регулярного платежа помечены recurringId — в плане они идут
// в «обязательные траты», а не в лимиты.
// =====================================================================

import * as db from './db.js';
import {
  formatMoney, parseMoney, moneyToInput, todayISO, addDays, daysBetween, fromISODate,
  shortDate, escapeHTML, monthRange, MONTHS,
} from './utils.js';
import { $, openSheet, closeSheet, shake, toast, actionSheet, focusField, isOpen } from './ui.js';

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const WEEKDAYS_LONG = ['понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];

// ---------------------------------------------------------------------
// Хранение
// ---------------------------------------------------------------------
export async function listRecurring() {
  return (await db.getAll('settings'))
    .filter((x) => x.id.startsWith('rec:'))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
async function saveRec(r) { await db.put('settings', r); }

// ---------------------------------------------------------------------
// Расписание
// ---------------------------------------------------------------------
const weekdayOf = (iso) => (fromISODate(iso).getDay() + 6) % 7; // 0 — пн
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(y, m, 0).getDate(); // m: 1..12

/** Даты платежа в промежутке [from, to] (с учётом начала и окончания). */
export function occurrences(r, from, to) {
  const start = r.start > from ? r.start : from;
  const end = r.end && r.end < to ? r.end : to;
  if (start > end) return [];
  const out = [];
  if (r.kind === 'month') {
    let [y, m] = start.split('-').map(Number);
    for (let i = 0; i < 400; i++) {
      const d = `${y}-${pad(m)}-${pad(Math.min(r.day, lastDay(y, m)))}`;
      if (d > end) break;
      if (d >= start) out.push(d);
      m++; if (m > 12) { m = 1; y++; }
    }
  } else if (r.kind === 'week') {
    for (let d = start; d <= end; d = addDays(d, 1)) if (weekdayOf(d) === r.weekday) out.push(d);
  } else if (r.kind === 'days') {
    const n = Math.max(1, r.every || 1);
    let k = Math.max(0, Math.ceil(daysBetween(r.start, start) / n));
    for (let d = addDays(r.start, k * n); d <= end; k++, d = addDays(r.start, k * n)) out.push(d);
  } else if (r.kind === 'year') {
    const [, mm, dd] = r.start.split('-').map(Number);
    for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) {
      const d = `${y}-${pad(mm)}-${pad(Math.min(dd, lastDay(y, mm)))}`;
      if (d >= start && d <= end) out.push(d);
    }
  }
  return out;
}

/** Ближайший платёж после даты (включительно). */
export function nextDue(r, fromISO = todayISO()) {
  return occurrences(r, fromISO, addDays(fromISO, 400))[0] || null;
}

/** «каждый месяц 15-го», «каждую неделю в пятницу», «каждые 30 дней», «каждый год 1 марта» */
export function scheduleLabel(r) {
  if (r.kind === 'month') return `каждый месяц ${r.day}-го`;
  if (r.kind === 'week') return `каждую неделю в ${WEEKDAYS_LONG[r.weekday]}`;
  if (r.kind === 'days') return `каждые ${r.every} дн.`;
  return `каждый год ${shortDate(r.start).replace(/ \d{4}$/, '')}`;
}

/** Обязательные траты месяца — сумма регулярных расходов, которые на него выпадают. */
export async function mandatoryForMonth(key) {
  const [y, m] = key.split('-').map(Number);
  const { from, to } = monthRange(y, m - 1);
  let sum = 0;
  for (const r of await listRecurring()) {
    if (r.type !== 'expense') continue;
    sum += occurrences(r, from, to).length * r.amount;
  }
  return sum;
}

/** Платежи в ближайшие N дней: [{ rec, date }] */
export async function upcoming(days = 7) {
  const today = todayISO();
  const res = [];
  for (const r of await listRecurring()) {
    for (const d of occurrences(r, addDays(today, 1), addDays(today, days))) res.push({ rec: r, date: d });
  }
  return res.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------
// Автодобавление при открытии
// ---------------------------------------------------------------------
/**
 * Внести всё, что подошло. Если такая трата уже есть (внесли вручную или
 * пришла из выписки: та же сумма и категория, ±3 дня) — не дублируем,
 * а помечаем её как оплату регулярного платежа.
 */
export async function processRecurring() {
  const today = todayISO();
  const added = [];
  for (const r of await listRecurring()) {
    const from = r.lastRun ? addDays(r.lastRun, 1) : r.start;
    const dues = occurrences(r, from, today);
    if (!dues.length) { if (!r.lastRun || r.lastRun < today) { r.lastRun = today; await saveRec(r); } continue; }
    const near = await db.getTransactionsBetween(addDays(dues[0], -3), addDays(dues[dues.length - 1], 3));
    for (const d of dues) {
      if (near.some((t) => t.recurringId === r.id && t.recurringDate === d)) continue;
      const match = near.find((t) => !t.recurringId && t.type === r.type && t.amount === r.amount
        && t.categoryId === r.categoryId && Math.abs(daysBetween(t.date, d)) <= 3);
      if (match) {
        await db.put('transactions', { ...match, recurringId: r.id, recurringDate: d });
        match.recurringId = r.id;
        continue;
      }
      if (r.askAmount) {
        r.pending = [...new Set([...(r.pending || []), d])].sort();
        continue;
      }
      const tx = {
        id: db.newId(), createdAt: Date.now() + added.length, type: r.type, amount: r.amount,
        categoryId: r.categoryId, date: d, comment: r.name, recurringId: r.id, recurringDate: d,
      };
      await db.put('transactions', tx);
      added.push(tx);
    }
    r.lastRun = today;
    await saveRec(r);
  }
  if (added.length) {
    const first = added[0];
    const more = added.length > 1 ? ` и ещё ${added.length - 1}` : '';
    setTimeout(() => toast(`🔁 Добавлено автоматически: ${first.comment} ${formatMoney(first.amount)}${more}`, 5000, {
      label: 'Отменить',
      async onClick() {
        for (const t of added) await db.remove('transactions', t.id);
        toast('Отменено — эти платежи пропущены');
        document.dispatchEvent(new Event('recurring-changed'));
      },
    }), 900);
  }
  return added;
}

// ---------------------------------------------------------------------
// Подтверждение платежей с плавающей суммой (главный экран)
// ---------------------------------------------------------------------
export async function renderPending() {
  const box = $('rec-pending');
  const items = [];
  for (const r of await listRecurring()) for (const d of r.pending || []) items.push({ r, d });
  if (!items.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<section class="card rec-pending">
    <div class="card-head"><h3>🔁 Подтвердите платежи</h3></div>
    ${items.map(({ r, d }) => `<div class="rec-pend-row" data-rec="${r.id}" data-date="${d}">
      <div class="rec-pend-main"><b>${escapeHTML(r.name)}</b><small class="muted">${shortDate(d)} · обычно ${formatMoney(r.amount)}</small></div>
      <button type="button" class="primary-btn rec-pend-ok">Ввести сумму</button>
      <button type="button" class="link-btn small-link rec-pend-skip">Пропустить</button>
    </div>`).join('')}
  </section>`;
}

async function confirmPending(recId, date, skip) {
  const r = await db.get('settings', recId);
  if (!r) return;
  if (!skip) {
    const text = prompt(`${r.name}: сколько заплатили ${shortDate(date)}, ₽?`, moneyToInput(r.amount));
    if (text === null) return;
    const amount = parseMoney(text);
    if (!(amount > 0)) { toast('Неверная сумма'); return; }
    await db.put('transactions', {
      id: db.newId(), createdAt: Date.now(), type: r.type, amount, categoryId: r.categoryId,
      date, comment: r.name, recurringId: r.id, recurringDate: date,
    });
    toast(`Добавлено: ${r.name} ${formatMoney(amount)}`);
  } else toast('Пропущено');
  r.pending = (r.pending || []).filter((x) => x !== date);
  await saveRec(r);
  document.dispatchEvent(new Event('recurring-changed'));
}

// ---------------------------------------------------------------------
// Подсказки «похоже на подписку»
// ---------------------------------------------------------------------
const norm = (s) => String(s || '').toLowerCase().replace(/[0-9*#№"'«».,:;()\-_/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

/** Повторы: тот же магазин и категория, сумма ±10%, интервал 25–35 дней. */
export async function findSuggestions() {
  const today = todayISO();
  const txs = (await db.getTransactionsBetween(addDays(today, -200), today))
    .filter((t) => t.type === 'expense' && !t.recurringId && norm(t.comment));
  const recs = await listRecurring();
  const dismissed = (await db.get('settings', 'recDismissed'))?.keys || [];
  const groups = new Map();
  for (const t of txs) {
    const k = `${norm(t.comment)}|${t.categoryId}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = [];
  for (const [k, list] of groups) {
    if (list.length < 2 || dismissed.includes(k)) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const last = list[list.length - 1];
    const monthly = list.some((t, i) => i > 0
      && daysBetween(list[i - 1].date, t.date) >= 25 && daysBetween(list[i - 1].date, t.date) <= 35
      && Math.abs(t.amount - list[i - 1].amount) <= list[i - 1].amount * 0.1);
    if (!monthly) continue;
    if (recs.some((r) => norm(r.name) === norm(last.comment) && r.categoryId === last.categoryId)) continue;
    out.push({ key: k, name: last.comment, amount: last.amount, categoryId: last.categoryId, lastDate: last.date, count: list.length });
  }
  return out;
}

// ---------------------------------------------------------------------
// Настройки → «Регулярные платежи»
// ---------------------------------------------------------------------
export async function renderRecurringSettings() {
  const cats = await db.getAll('categories');
  const recs = await listRecurring();
  $('rec-list').innerHTML = recs.length
    ? recs.map((r) => {
      const c = cats.find((x) => x.id === r.categoryId);
      const next = nextDue(r);
      return `<button type="button" class="rec-row" data-rec="${r.id}">
        <span class="tx-emoji">${c ? c.emoji : '🔁'}</span>
        <span class="rec-main"><b>${escapeHTML(r.name)}</b>
          <small class="muted">${scheduleLabel(r)}${next ? ` · след. ${shortDate(next)}` : ' · закончился'}${r.askAmount ? ' · спросить сумму' : ''}</small></span>
        <b class="${r.type === 'income' ? 'income' : ''}">${r.type === 'income' ? '+' : '−'}${formatMoney(r.amount)}</b>
      </button>`;
    }).join('')
    : '<p class="small muted" style="margin:0 0 6px">Подписки, связь, проездной — внесите один раз, дальше приложение добавит их само.</p>';

  const sug = await findSuggestions();
  $('rec-suggest').innerHTML = sug.length
    ? `<div class="section-title">Похоже на регулярные</div>${sug.map((s) => {
      const c = cats.find((x) => x.id === s.categoryId);
      return `<div class="rec-sug" data-key="${escapeHTML(s.key)}">
        <span class="rec-main"><b>${c ? c.emoji : ''} ${escapeHTML(s.name)}</b>
          <small class="muted">${formatMoney(s.amount)} · ${s.count} раза примерно раз в месяц</small></span>
        <button type="button" class="primary-btn rec-sug-yes">Сделать</button>
        <button type="button" class="link-btn small-link rec-sug-no" aria-label="Скрыть подсказку">✕</button>
      </div>`;
    }).join('')}`
    : '';
  state.suggestions = sug;
}

// ---------------------------------------------------------------------
// Окно платежа
// ---------------------------------------------------------------------
const state = { editing: null, type: 'expense', kind: 'month', weekday: 0, suggestions: [], fromTx: null };

/**
 * Открыть окно платежа. rec — существующий; tx — сделать регулярной эту трату;
 * sug — из подсказки.
 */
export async function openRecSheet({ rec = null, tx = null, sug = null } = {}) {
  state.editing = rec;
  state.fromTx = tx;
  const base = rec || (tx && { name: tx.comment || '', amount: tx.amount, categoryId: tx.categoryId, type: tx.type, start: tx.date })
    || (sug && { name: sug.name, amount: sug.amount, categoryId: sug.categoryId, type: 'expense', start: sug.lastDate }) || {};
  const start = base.start || todayISO();
  state.type = base.type || 'expense';
  state.kind = rec ? rec.kind : 'month';
  state.weekday = rec ? rec.weekday ?? weekdayOf(start) : weekdayOf(start);
  $('rec-title').textContent = rec ? 'Регулярный платёж' : 'Новый регулярный';
  $('rec-amount').value = base.amount ? moneyToInput(base.amount) : '';
  $('rec-name').value = base.name || '';
  $('rec-day').value = rec?.day || Number(start.slice(8));
  $('rec-every').value = rec?.every || 30;
  $('rec-start').value = start;
  $('rec-end').value = rec?.end || '';
  $('rec-ask').checked = !!rec?.askAmount;
  $('rec-delete').hidden = !rec;
  await renderCatOptions(base.categoryId);
  renderRecForm();
  openSheet($('rec-sheet'));
  if (!rec && !tx && !sug) focusField($('rec-amount'));
}

async function renderCatOptions(selected) {
  const cats = (await db.getAll('categories')).filter((c) => c.type === state.type && !c.archived).sort((a, b) => a.order - b.order);
  $('rec-cat').innerHTML = cats.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.emoji} ${escapeHTML(c.name)}</option>`).join('');
}

function draft() {
  return {
    kind: state.kind, weekday: state.weekday,
    day: Math.min(31, Math.max(1, Number($('rec-day').value) || 1)),
    every: Math.max(1, Number($('rec-every').value) || 30),
    start: $('rec-start').value || todayISO(), end: $('rec-end').value || '',
  };
}

function renderRecForm() {
  for (const b of $('rec-type').querySelectorAll('button')) b.classList.toggle('active', b.dataset.type === state.type);
  for (const b of $('rec-kind').querySelectorAll('button')) b.classList.toggle('active', b.dataset.kind === state.kind);
  for (const b of $('rec-weekday').querySelectorAll('button')) b.classList.toggle('active', Number(b.dataset.wd) === state.weekday);
  $('rec-month-fields').hidden = state.kind !== 'month';
  $('rec-week-fields').hidden = state.kind !== 'week';
  $('rec-days-fields').hidden = state.kind !== 'days';
  const d = draft();
  // Сделать регулярной уже оплаченную трату — следующая дата после неё
  const from = state.fromTx ? addDays(state.fromTx.date, 1) : todayISO();
  const next = nextDue(d, from > d.start ? from : d.start);
  $('rec-info').innerHTML = `${scheduleLabel(d)}${next ? `<br>Следующий платёж: <b>${shortDate(next)}</b>` : '<br>В этом периоде платежей нет'}`
    + (d.kind === 'year' ? '<br><span class="muted">Дата — как у дня начала</span>' : '');
}

async function saveRecSheet(e) {
  e.preventDefault();
  const amount = parseMoney($('rec-amount').value);
  if (!(amount > 0)) { shake($('rec-amount')); return; }
  const name = $('rec-name').value.trim();
  if (!name) { shake($('rec-name')); $('rec-name').focus(); return; }
  const d = draft();
  if (d.end && d.end < d.start) { shake($('rec-end')); toast('Окончание раньше начала'); return; }
  const old = state.editing;
  const r = {
    ...(old || { id: 'rec:' + db.newId(), createdAt: Date.now(), pending: [] }),
    name, amount, type: state.type, categoryId: $('rec-cat').value, ...d,
    askAmount: $('rec-ask').checked,
  };
  if (!old) {
    // Платежи до сегодняшнего дня не добавляем задним числом. Из траты — она и есть первая оплата.
    if (state.fromTx) {
      r.lastRun = state.fromTx.date;
      await db.put('transactions', { ...state.fromTx, recurringId: r.id, recurringDate: state.fromTx.date });
    } else r.lastRun = addDays(todayISO() > d.start ? todayISO() : d.start, -1);
  }
  await saveRec(r);
  closeSheet($('rec-sheet'));
  if (isOpen($('tx-sheet'))) closeSheet($('tx-sheet')); // открывали из окна траты — закрываем и его
  if (state.sugKey) await dismissSuggestion(state.sugKey);
  state.sugKey = null;
  toast(`🔁 ${name}: ${scheduleLabel(r)}`);
  document.dispatchEvent(new Event('recurring-changed'));
  // Если платёж приходится на сегодня — сразу внести
  await processRecurring();
  document.dispatchEvent(new Event('recurring-changed'));
}

async function deleteRec() {
  const r = state.editing;
  actionSheet(`<span class="as-danger">Удалить регулярный платёж «${escapeHTML(r.name)}»? Уже внесённые траты останутся.</span>`, [{
    label: 'Удалить', danger: true,
    async onClick() {
      await db.remove('settings', r.id);
      closeSheet($('rec-sheet'));
      toast('Регулярный платёж удалён');
      document.dispatchEvent(new Event('recurring-changed'));
    },
  }]);
}

async function dismissSuggestion(key) {
  const cur = (await db.get('settings', 'recDismissed'))?.keys || [];
  await db.put('settings', { id: 'recDismissed', keys: [...new Set([...cur, key])] });
}

export function initRecurring() {
  $('rec-new').addEventListener('click', () => openRecSheet());
  $('rec-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rec]');
    if (b) openRecSheet({ rec: await db.get('settings', b.dataset.rec) });
  });
  $('rec-suggest').addEventListener('click', async (e) => {
    const row = e.target.closest('.rec-sug');
    if (!row) return;
    const key = row.dataset.key;
    if (e.target.closest('.rec-sug-no')) {
      await dismissSuggestion(key);
      renderRecurringSettings();
      return;
    }
    if (e.target.closest('.rec-sug-yes')) {
      const sug = state.suggestions.find((s) => s.key === key);
      if (!sug) return;
      state.sugKey = key;
      // Последняя трата из подсказки — первая оплата, повторно не добавляем
      const txs = await db.getTransactionsBetween(sug.lastDate, sug.lastDate);
      const tx = txs.find((t) => norm(t.comment) === norm(sug.name) && t.categoryId === sug.categoryId && !t.recurringId);
      openRecSheet(tx ? { tx } : { sug });
    }
  });
  $('rec-type').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.type = b.dataset.type;
    await renderCatOptions(null);
    renderRecForm();
  });
  $('rec-kind').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.kind = b.dataset.kind;
    renderRecForm();
  });
  $('rec-weekday').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.weekday = Number(b.dataset.wd);
    renderRecForm();
  });
  for (const id of ['rec-day', 'rec-every', 'rec-start', 'rec-end']) $(id).addEventListener('input', renderRecForm);
  $('rec-sheet').addEventListener('submit', saveRecSheet);
  $('rec-delete').addEventListener('click', deleteRec);
  // Подтверждение сумм на главном экране
  $('rec-pending').addEventListener('click', (e) => {
    const row = e.target.closest('.rec-pend-row');
    if (!row) return;
    if (e.target.closest('.rec-pend-ok')) confirmPending(row.dataset.rec, row.dataset.date, false);
    if (e.target.closest('.rec-pend-skip')) confirmPending(row.dataset.rec, row.dataset.date, true);
  });
}

export { WEEKDAYS, MONTHS };

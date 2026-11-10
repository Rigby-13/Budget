// =====================================================================
// savings.js — накопления (копилка). Раздел внутри «Статистики».
//
// Запись в таблице savings:
// { id, date: 'ГГГГ-ММ-ДД', amount: копейки (+ отложил, − взял),
//   kind: 'deposit' | 'withdraw' | 'month', month?: 'ГГГГ-ММ', comment, createdAt }
// kind 'month' — итог месяца: «отложить по плану + экономия − превышение».
// Если месяц пропустили — запись с amount 0, чтобы больше не предлагать.
// =====================================================================

import * as db from './db.js';
import {
  formatMoney, parseMoney, todayISO, yesterdayISO, shortDate, escapeHTML, MONTHS, MONTHS_GEN,
} from './utils.js';
import { $, openSheet, closeSheet, shake, toast, actionSheet, focusField } from './ui.js';
import { getPlan, monthResult, monthBounds, currentMonthKey, prevMonthKey } from './plan.js';

const monthName = (key) => MONTHS[Number(key.slice(5, 7)) - 1].toLowerCase();
const monthGen = (key) => MONTHS_GEN[Number(key.slice(5, 7)) - 1];

async function entries() {
  return (await db.getAll('savings')).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

async function addEntry(e) {
  await db.put('savings', { id: db.newId(), createdAt: Date.now(), date: todayISO(), comment: '', ...e });
  document.dispatchEvent(new Event('savings-changed'));
}

// ---------------------------------------------------------------------
// Итоги месяца → сколько предложить отложить
// ---------------------------------------------------------------------
/** { plan, res, suggest } для прошедшего месяца или null, если плана не было. */
export async function monthSuggestion(key) {
  const plan = await getPlan(key);
  if (!plan) return null;
  const { from, to } = monthBounds(key);
  const categories = await db.getAll('categories');
  const res = monthResult(plan, categories, await db.getTransactionsBetween(from, to), to);
  const suggest = Math.max(0, plan.savings + res.saved - res.over);
  return { plan, res, suggest };
}

async function closeEntry(key) {
  return (await db.getAll('savings')).find((e) => e.kind === 'month' && e.month === key) || null;
}

/** Прошедшие месяцы с планом, по которым ещё не решили, сколько отложить. */
async function pendingMonths() {
  const cur = currentMonthKey();
  const list = [];
  let key = prevMonthKey(cur);
  for (let i = 0; i < 12; i++, key = prevMonthKey(key)) {
    const plan = await getPlan(key);
    if (!plan) break; // раньше планов не было
    if (!(await closeEntry(key))) list.push(key);
  }
  return list;
}

/** Блок для карточки «Итоги месяца» на главном экране. */
export async function monthCloseBlock(key) {
  const done = await closeEntry(key);
  if (done) {
    return `<div class="sav-done">${done.amount > 0
      ? `✓ В копилку отложено ${formatMoney(done.amount)}`
      : '✓ В этом месяце решили не откладывать'}</div>`;
  }
  const s = await monthSuggestion(key);
  if (!s) return '';
  return closeButtons(key, s);
}

function closeButtons(key, s) {
  const parts = [`${formatMoney(s.plan.savings)} по плану`];
  if (s.res.saved) parts.push(`+ ${formatMoney(s.res.saved)} экономия`);
  if (s.res.over) parts.push(`− ${formatMoney(s.res.over)} превышение`);
  return `<div class="sav-close">
    <p class="small muted" style="margin:10px 0 6px">${parts.join(' ')}</p>
    <button type="button" class="primary-btn full" data-sav-close="${key}" data-amount="${s.suggest}">
      Отложить ${formatMoney(s.suggest)} в копилку</button>
    <div class="sav-alt">
      <button type="button" class="link-btn" data-sav-other="${key}" data-amount="${s.suggest}">Другая сумма</button>
      <button type="button" class="link-btn" data-sav-skip="${key}">Не откладывать</button>
    </div>
  </div>`;
}

async function closeMonth(key, amount) {
  await addEntry({ kind: 'month', month: key, amount, comment: `Итоги ${monthGen(key)}` });
  toast(amount > 0 ? `В копилку: +${formatMoney(amount)} 🐷` : 'Хорошо, в этот раз не откладываем');
}

// ---------------------------------------------------------------------
// Раздел «Накопления»
// ---------------------------------------------------------------------
export async function renderSavings() {
  const list = await entries();
  const balance = list.reduce((s, e) => s + e.amount, 0);
  $('sav-balance').textContent = formatMoney(balance);

  // Этот месяц: план и экономия на сегодня (по вчерашний день)
  const cur = currentMonthKey();
  const plan = await getPlan(cur);
  let monthHtml = '<p class="small muted" style="margin:0">Плана на этот месяц нет — копилка пополняется вручную.</p>';
  if (plan) {
    const { from, to } = monthBounds(cur);
    const categories = await db.getAll('categories');
    const res = monthResult(plan, categories, await db.getTransactionsBetween(from, to), yesterdayISO());
    const net = res.saved - res.over;
    monthHtml = `<div class="plan-table">
        <div><span>Отложить по плану</span><b>${formatMoney(plan.savings)}</b></div>
        <div><span>Экономия пока</span><b class="${net < 0 ? 'negative' : 'income'}">${net >= 0 ? '+' : '−'}${formatMoney(Math.abs(net))}</b></div>
      </div>
      <p class="small muted" style="margin:10px 0 0">1-го числа предложим отложить ≈ ${formatMoney(Math.max(0, plan.savings + net))}.
      Месячные лимиты подводятся в конце месяца.</p>`;
  }
  $('sav-month-title').textContent = `Этот месяц · ${monthName(cur)}`;
  $('sav-month').innerHTML = monthHtml;

  // Месяцы, по которым ждём решения
  const pending = await pendingMonths();
  let pendHtml = '';
  for (const key of pending) {
    const s = await monthSuggestion(key);
    pendHtml += `<section class="card sav-pending">
      <b>Итоги ${monthGen(key)}</b>
      <div class="small">Сэкономлено <span class="income">+${formatMoney(s.res.saved)}</span> · превышение <span class="negative">−${formatMoney(s.res.over)}</span></div>
      ${closeButtons(key, s)}
    </section>`;
  }
  $('sav-pending').innerHTML = pendHtml;

  // По месяцам и за всё время (месяцы с планом)
  const rows = [];
  let totalSaved = 0, totalOver = 0;
  let key = prevMonthKey(cur);
  for (let i = 0; i < 24; i++, key = prevMonthKey(key)) {
    const s = await monthSuggestion(key);
    if (!s) break;
    const done = await closeEntry(key);
    totalSaved += s.res.saved;
    totalOver += s.res.over;
    rows.push(`<div class="daily-row">
      <div class="daily-name"><span>${MONTHS[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}</span>
        <small class="muted">${done ? (done.amount ? `отложено ${formatMoney(done.amount)}` : 'не откладывали') : 'ждёт решения'}</small></div>
      <div class="daily-sums">
        ${s.res.saved ? `<span class="income">+${formatMoney(s.res.saved)}</span>` : ''}
        ${s.res.over ? `<span class="negative">−${formatMoney(s.res.over)}</span>` : ''}
        ${!s.res.saved && !s.res.over ? '<span class="muted">0 ₽</span>' : ''}
      </div>
    </div>`);
  }
  $('sav-alltime').innerHTML = rows.length
    ? `<div class="daily-totals">
        <div><span class="muted">Сэкономлено</span><b class="income">+${formatMoney(totalSaved)}</b></div>
        <div><span class="muted">Превышено</span><b class="negative">−${formatMoney(totalOver)}</b></div>
        <div><span class="muted">Итого</span><b class="${totalSaved - totalOver < 0 ? 'negative' : 'income'}">${formatMoney(totalSaved - totalOver)}</b></div>
      </div>${rows.join('')}`
    : '<p class="small muted" style="margin:0">Здесь появятся итоги завершённых месяцев с планом.</p>';

  // История копилки
  $('sav-history').innerHTML = list.length
    ? list.map((e) => `<button type="button" class="tx" data-sav-id="${e.id}">
        <span class="tx-emoji">${e.kind === 'month' ? '🏁' : e.amount >= 0 ? '🐷' : '💸'}</span>
        <span class="tx-main">
          <div class="tx-cat">${escapeHTML(e.comment || (e.amount >= 0 ? 'Отложил' : 'Взял'))}</div>
          <div class="tx-comment">${shortDate(e.date)}</div>
        </span>
        <span class="tx-amount ${e.amount > 0 ? 'income' : ''}">${e.amount > 0 ? '+' : e.amount < 0 ? '−' : ''}${formatMoney(Math.abs(e.amount))}</span>
      </button>`).join('')
    : '<div class="empty small">Пока пусто. Нажмите «Отложить», чтобы положить деньги в копилку.</div>';
}

// ---------------------------------------------------------------------
// Окно «Отложить / Взять»
// ---------------------------------------------------------------------
let sheetKind = 'deposit';

function openSavSheet(kind) {
  sheetKind = kind;
  for (const b of $('sav-kind').querySelectorAll('button')) b.classList.toggle('active', b.dataset.kind === kind);
  $('sav-amount').value = '';
  $('sav-comment').value = '';
  openSheet($('sav-sheet'));
  focusField($('sav-amount'));
}

async function saveSavSheet(e) {
  e.preventDefault();
  const amount = parseMoney($('sav-amount').value);
  if (!(amount > 0)) { shake($('sav-amount')); return; }
  const sign = sheetKind === 'withdraw' ? -1 : 1;
  await addEntry({ kind: sheetKind, amount: sign * amount, comment: $('sav-comment').value.trim() });
  closeSheet($('sav-sheet'));
  toast(sign > 0 ? `В копилку: +${formatMoney(amount)} 🐷` : `Из копилки: −${formatMoney(amount)}`);
}

export function initSavings() {
  $('sav-add').addEventListener('click', () => openSavSheet('deposit'));
  $('sav-take').addEventListener('click', () => openSavSheet('withdraw'));
  $('sav-kind').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    sheetKind = b.dataset.kind;
    for (const x of $('sav-kind').querySelectorAll('button')) x.classList.toggle('active', x === b);
  });
  $('sav-sheet').addEventListener('submit', saveSavSheet);

  // Кнопки итогов месяца — и на главном экране, и в «Накоплениях»
  document.addEventListener('click', async (e) => {
    const close = e.target.closest('[data-sav-close]');
    if (close) { await closeMonth(close.dataset.savClose, Number(close.dataset.amount)); return; }
    const other = e.target.closest('[data-sav-other]');
    if (other) {
      const text = prompt('Сколько отложить, ₽?', String(Number(other.dataset.amount) / 100));
      if (text === null) return;
      const amount = parseMoney(text);
      if (!(amount >= 0)) { toast('Неверная сумма'); return; }
      await closeMonth(other.dataset.savOther, amount);
      return;
    }
    const skip = e.target.closest('[data-sav-skip]');
    if (skip) { await closeMonth(skip.dataset.savSkip, 0); return; }
    const row = e.target.closest('[data-sav-id]');
    if (row) {
      const entry = await db.get('savings', row.dataset.savId);
      actionSheet(`${entry.comment || 'Запись'} · ${formatMoney(Math.abs(entry.amount))}`, [{
        label: 'Удалить запись', danger: true,
        async onClick() {
          if (!confirm('Удалить запись из копилки?')) return;
          await db.remove('savings', entry.id);
          document.dispatchEvent(new Event('savings-changed'));
        },
      }]);
    }
  });
}

// =====================================================================
// savings.js — накопления (копилка). Раздел внутри «Статистики».
//
// Запись в таблице savings:
// { id, date: 'ГГГГ-ММ-ДД', amount: копейки (+ отложил, − взял),
//   kind: 'deposit' | 'withdraw' | 'month', month?: 'ГГГГ-ММ', comment, createdAt }
// kind 'month' — итог месяца из старых версий (до 8.0).
// =====================================================================

import * as db from './db.js';
import { formatMoney, parseMoney, todayISO, shortDate, escapeHTML } from './utils.js';
import { $, openSheet, closeSheet, shake, toast, actionSheet, focusField } from './ui.js';

async function entries() {
  return (await db.getAll('savings')).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

async function addEntry(e) {
  await db.put('savings', { id: db.newId(), createdAt: Date.now(), date: todayISO(), comment: '', ...e });
  document.dispatchEvent(new Event('savings-changed'));
}

// ---------------------------------------------------------------------
// Раздел «Накопления»
// ---------------------------------------------------------------------
export async function renderSavings() {
  const list = await entries();
  const balance = list.reduce((s, e) => s + e.amount, 0);
  $('sav-balance').textContent = formatMoney(balance);

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

  // Нажатие на запись копилки — удалить
  document.addEventListener('click', async (e) => {
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

// =====================================================================
// reset.js — Настройки → «Удаление записей».
//   • траты и доходы за выбранные месяцы;
//   • все траты и доходы;
//   • полный сброс приложения (как после установки).
// Перед удалением — красное предупреждение и подтверждение.
// =====================================================================

import * as db from './db.js';
import { formatMoney, MONTHS } from './utils.js';
import { $, actionSheet, toast } from './ui.js';

const selected = new Set(); // выбранные месяцы 'ГГГГ-ММ'

const word = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'запись'
  : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'записи' : 'записей');

/** Месяцы, в которых есть записи: количество и сумма расходов. */
async function monthsWithRecords() {
  const map = new Map();
  for (const t of await db.getAll('transactions')) {
    const k = t.date.slice(0, 7);
    if (!map.has(k)) map.set(k, { key: k, count: 0, expense: 0, income: 0 });
    const m = map.get(k);
    m.count++;
    if (t.type === 'income') m.income += t.amount; else m.expense += t.amount;
  }
  return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
}

/** Красный текст предупреждения для меню подтверждения. */
const warn = (strings, ...vals) => `<span class="as-danger">${String.raw({ raw: strings }, ...vals)}</span>`;

const monthTitle = (k) => `${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}`;

export async function renderReset() {
  const months = await monthsWithRecords();
  for (const k of [...selected]) if (!months.some((m) => m.key === k)) selected.delete(k);
  $('reset-months').innerHTML = months.length
    ? months.map((m) => `<label class="reset-month">
        <input type="checkbox" data-month="${m.key}" ${selected.has(m.key) ? 'checked' : ''}>
        <span class="reset-month-name">${monthTitle(m.key)}</span>
        <small class="muted">${m.count} ${word(m.count)} · −${formatMoney(m.expense)}</small>
      </label>`).join('')
    : '<p class="small muted" style="margin:0">Записей пока нет.</p>';
  const n = months.filter((m) => selected.has(m.key)).reduce((s, m) => s + m.count, 0);
  $('reset-selected').disabled = !n;
  $('reset-selected').textContent = n ? `Удалить выбранное · ${n} ${word(n)}` : 'Выберите месяцы';
  const total = months.reduce((s, m) => s + m.count, 0);
  $('reset-all-tx').disabled = !total;
}

async function deleteMonths() {
  const months = (await monthsWithRecords()).filter((m) => selected.has(m.key));
  const n = months.reduce((s, m) => s + m.count, 0);
  if (!n) return;
  actionSheet(warn`⚠️ Будут удалены ${n} ${word(n)} за: ${months.map((m) => monthTitle(m.key)).join(', ')}. Это нельзя отменить.`, [{
    label: `Удалить ${n} ${word(n)}`, danger: true,
    async onClick() {
      const keys = new Set(months.map((m) => m.key));
      for (const t of await db.getAll('transactions')) {
        if (keys.has(t.date.slice(0, 7))) await db.remove('transactions', t.id);
      }
      selected.clear();
      done(`Удалено: ${n} ${word(n)}`);
    },
  }]);
}

async function deleteAllTx() {
  const all = await db.getAll('transactions');
  if (!all.length) return;
  actionSheet(warn`⚠️ Будут удалены ВСЕ траты и доходы — ${all.length} ${word(all.length)} за всё время. Долги, копилка и планы останутся. Это нельзя отменить.`, [{
    label: `Удалить все ${all.length} ${word(all.length)}`, danger: true,
    async onClick() {
      if (!confirm('Точно удалить все траты и доходы? Вернуть их можно будет только из резервной копии.')) return;
      for (const t of all) await db.remove('transactions', t.id);
      done('Все траты и доходы удалены');
    },
  }]);
}

function resetApp() {
  actionSheet(warn`⚠️ Полный сброс: удалятся траты, доходы, долги, копилка, планы, лимиты и ваши категории. Приложение станет как после установки. Это нельзя отменить.`, [{
    label: 'Сбросить всё приложение', danger: true,
    async onClick() {
      if (!confirm('Последнее предупреждение: удалить ВСЕ данные? Восстановить можно только из резервной копии.')) return;
      await db.importAll({});
      for (const k of ['lastCat:expense', 'lastCat:income', 'detailsOpen', 'planReminder', 'monthReportClosed', 'lastImport', 'lastBackup']) {
        try { localStorage.removeItem(k); } catch { /* ничего */ }
      }
      location.reload();
    },
  }]);
}

function done(msg) {
  toast(`🗑 ${msg}`, 3000);
  document.dispatchEvent(new Event('categories-changed')); // перерисовать траты, план, статистику
  renderReset();
}

export function initReset() {
  $('reset-months').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-month]');
    if (!cb) return;
    if (cb.checked) selected.add(cb.dataset.month); else selected.delete(cb.dataset.month);
    renderReset();
  });
  $('reset-selected').addEventListener('click', deleteMonths);
  $('reset-all-tx').addEventListener('click', deleteAllTx);
  $('reset-app').addEventListener('click', resetApp);
  $('reset-backup').addEventListener('click', () => $('backup-export').click());
}

// =====================================================================
// limits.js — лимиты по категориям расходов.
//
//  • Лимит в месяц: category.limit (копейки, 0 — нет лимита)
//  • Лимит в день:  category.dailyLimits — история значений:
//      [{ from: 'ГГГГ-ММ-ДД', amount: копейки }, ...]
//    Храним историю, чтобы при смене лимита прошлые дни считались
//    по тому лимиту, который действовал тогда. amount: 0 — лимит снят.
//
// Сэкономлено / превышение считаются только за ЗАВЕРШЁННЫЕ дни
// (сегодняшний день ещё идёт). Это не отдельные записи в базе —
// всё пересчитывается из трат, поэтому правки старых трат учитываются.
// =====================================================================

import * as db from './db.js';
import { formatMoney, todayISO, toISODate, fromISODate, monthRange } from './utils.js';
import { toast } from './ui.js';

// ---------------------------------------------------------------------
// Лимит в день
// ---------------------------------------------------------------------

/** Какой дневной лимит действовал у категории в этот день (0 — никакого). */
export function dailyLimitOn(cat, iso) {
  let amount = 0;
  for (const e of cat.dailyLimits || []) {
    if (e.from <= iso) amount = e.amount; // записи отсортированы по дате
  }
  return amount;
}

/** Текущий дневной лимит категории. */
export function currentDailyLimit(cat) {
  return dailyLimitOn(cat, todayISO());
}

/** Новая история лимитов, если лимит меняется с сегодняшнего дня. */
export function withDailyLimit(cat, amount) {
  const today = todayISO();
  if (currentDailyLimit(cat) === amount) return cat.dailyLimits || [];
  const list = (cat.dailyLimits || []).filter((e) => e.from !== today);
  list.push({ from: today, amount });
  return list.sort((a, b) => a.from.localeCompare(b.from));
}

/** Есть ли у категории хоть когда-нибудь дневной лимит. */
export function hasDailyLimits(cat) {
  return (cat.dailyLimits || []).some((e) => e.amount > 0);
}

/** Суммы трат по ключу "категория|день". */
function spentByCatDay(transactions) {
  const m = new Map();
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    const k = t.categoryId + '|' + t.date;
    m.set(k, (m.get(k) || 0) + t.amount);
  }
  return m;
}

/**
 * Итоги дневных лимитов за период [from, to] — только завершённые дни.
 * Возвращает { saved, over, rows: [{ category, saved, over, daysOk, daysOver }] }
 */
export function dailyResults(categories, transactions, from, to) {
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yesterday = toISODate(y);
  if (to > yesterday) to = yesterday;
  const cats = categories.filter((c) => c.type === 'expense' && hasDailyLimits(c))
    .sort((a, b) => a.order - b.order);
  const spent = spentByCatDay(transactions);
  const rows = [];

  for (const cat of cats) {
    const row = { category: cat, saved: 0, over: 0, daysOk: 0, daysOver: 0 };
    for (let d = fromISODate(from); toISODate(d) <= to; d.setDate(d.getDate() + 1)) {
      const iso = toISODate(d);
      const limit = dailyLimitOn(cat, iso);
      if (!limit) continue;
      const s = spent.get(cat.id + '|' + iso) || 0;
      if (s <= limit) { row.saved += limit - s; row.daysOk++; }
      else { row.over += s - limit; row.daysOver++; }
    }
    if (row.daysOk || row.daysOver) rows.push(row);
  }
  return {
    saved: rows.reduce((s, r) => s + r.saved, 0),
    over: rows.reduce((s, r) => s + r.over, 0),
    rows,
  };
}

/** Состояние дневных лимитов на сегодня: сколько потрачено и осталось. */
export function todayStatuses(categories, transactions) {
  const today = todayISO();
  const spent = spentByCatDay(transactions);
  return categories
    .filter((c) => c.type === 'expense' && !c.archived && currentDailyLimit(c) > 0)
    .sort((a, b) => a.order - b.order)
    .map((c) => {
      const limit = currentDailyLimit(c);
      const s = spent.get(c.id + '|' + today) || 0;
      const pct = Math.round((s / limit) * 100);
      return { category: c, spent: s, limit, pct, status: pct > 100 ? 'over' : pct >= 80 ? 'warn' : 'ok' };
    });
}

// ---------------------------------------------------------------------
// Лимит в месяц
// ---------------------------------------------------------------------
/**
 * Для каждой категории с месячным лимитом: сколько потрачено и статус.
 * status: 'ok' (< 80%), 'warn' (80–99%), 'over' (100% и больше)
 */
export function limitStatuses(categories, monthTransactions) {
  const spent = new Map();
  for (const t of monthTransactions) {
    if (t.type === 'expense') spent.set(t.categoryId, (spent.get(t.categoryId) || 0) + t.amount);
  }
  return categories
    .filter((c) => c.type === 'expense' && c.limit > 0 && !c.archived)
    .sort((a, b) => a.order - b.order)
    .map((c) => {
      const s = spent.get(c.id) || 0;
      const pct = Math.round((s / c.limit) * 100);
      return { category: c, spent: s, limit: c.limit, pct, status: pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok' };
    });
}

// ---------------------------------------------------------------------
// Предупреждение после добавления траты
// ---------------------------------------------------------------------
/** Возвращает true, если показали предупреждение. */
export async function checkLimitAfterSave(tx) {
  if (tx.type !== 'expense') return false;
  const cat = await db.get('categories', tx.categoryId);
  if (!cat) return false;
  const [y, m] = tx.date.split('-').map(Number);
  const { from, to } = monthRange(y, m - 1);
  const items = await db.getTransactionsBetween(from, to);

  // Сначала дневной лимит (только для сегодняшних трат)
  if (tx.date === todayISO() && currentDailyLimit(cat) > 0) {
    const d = todayStatuses([cat], items)[0];
    if (d.status === 'over') {
      toast(`⛔ «${cat.name}»: дневной лимит превышен на ${formatMoney(d.spent - d.limit)}`, 4000);
      return true;
    }
    if (d.status === 'warn') {
      toast(`⚠️ «${cat.name}»: на сегодня осталось ${formatMoney(d.limit - d.spent)}`, 4000);
      return true;
    }
  }

  if (cat.limit > 0) {
    const st = limitStatuses([cat], items)[0];
    if (st.status === 'over') {
      toast(`⛔ Месячный лимит «${cat.name}» превышен: ${formatMoney(st.spent)} из ${formatMoney(st.limit)}`, 4000);
      return true;
    }
    if (st.status === 'warn') {
      toast(`⚠️ «${cat.name}»: ${st.pct}% месячного лимита, осталось ${formatMoney(st.limit - st.spent)}`, 4000);
      return true;
    }
  }

  // Всё в порядке, но покажем остаток на день — это полезно
  if (tx.date === todayISO() && currentDailyLimit(cat) > 0) {
    const d = todayStatuses([cat], items)[0];
    toast(`Добавлено · на сегодня осталось ${formatMoney(d.limit - d.spent)}`, 3000);
    return true;
  }
  return false;
}

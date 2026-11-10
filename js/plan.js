// =====================================================================
// plan.js — план на месяц (мастер-лимит) и лимиты по категориям.
// Здесь только расчёты, без интерфейса.
//
// План хранится в таблице settings, отдельно на каждый месяц:
// {
//   id: 'plan:2026-11', month: '2026-11',
//   income:  2000000,   // бюджет на месяц, копейки (0 — не задан)
//   savings:  500000,   // сколько отложить в копилку
//   limits: [
//     { categoryId, period: 'day' | 'week' | 'month', amount, since: 'ГГГГ-ММ-ДД' }
//   ]
// }
// Если на месяц плана нет — берётся план прошлого месяца (копия).
//
// Как работает лимит в день / в неделю:
//   ставка в день = лимит в день  или  лимит в неделю / 7.
//   Лимит на сегодня = ставка × (дней с начала до сегодня) − потрачено до сегодня.
//   То есть экономия прошлых дней прибавляется к сегодняшнему лимиту,
//   а перерасход — вычитается. 1-го числа всё начинается заново.
// Лимит в месяц: просто «потрачено из N за месяц», без деления на дни.
// Траты в категориях без своего лимита идут из «свободных» денег плана.
// =====================================================================

import * as db from './db.js';
import { monthRange, daysBetween, todayISO, yesterdayISO, addDays, now } from './utils.js';

export const PERIODS = {
  day: { label: 'В день', short: 'в день' },
  week: { label: 'В неделю', short: 'в неделю' },
  month: { label: 'В месяц', short: 'в месяц' },
};

// ---------------------------------------------------------------------
// Месяцы
// ---------------------------------------------------------------------
/** 'ГГГГ-ММ' для даты или строки 'ГГГГ-ММ-ДД'. */
export function monthKeyOf(x) {
  if (typeof x === 'string') return x.slice(0, 7);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
}
export function currentMonthKey() {
  return monthKeyOf(now());
}
export function monthBounds(key) {
  const [y, m] = key.split('-').map(Number);
  return monthRange(y, m - 1);
}
export function prevMonthKey(key) {
  const [y, m] = key.split('-').map(Number);
  return monthKeyOf(new Date(y, m - 2, 1));
}

// ---------------------------------------------------------------------
// Загрузка и сохранение плана
// ---------------------------------------------------------------------
/**
 * План на месяц. Если своего нет — копия последнего более раннего плана
 * (с пометкой inherited). Если планов нет вообще — null.
 */
export async function getPlan(key) {
  const own = await db.get('settings', 'plan:' + key);
  if (own) return own;
  const earlier = (await db.getAll('settings'))
    .filter((s) => s.id.startsWith('plan:') && s.month < key)
    .sort((a, b) => b.month.localeCompare(a.month))[0];
  if (!earlier) return null;
  const { from } = monthBounds(key);
  return {
    id: 'plan:' + key, month: key, inherited: true,
    income: earlier.income, savings: earlier.savings,
    limits: earlier.limits.map((l) => ({ ...l, since: from })),
  };
}

/** План месяца для редактирования (по умолчанию текущего; пустой, если нет). */
export async function getPlanForEdit(key = currentMonthKey()) {
  return (await getPlan(key)) || { id: 'plan:' + key, month: key, income: 0, savings: 0, limits: [] };
}

export async function savePlan(plan) {
  const { inherited, ...clean } = plan;
  await db.put('settings', clean);
}

/** Добавить или изменить лимит категории в плане (без сохранения). */
export function setLimit(plan, categoryId, period, amount) {
  const existing = plan.limits.find((l) => l.categoryId === categoryId);
  if (existing) {
    existing.period = period;
    existing.amount = amount;
  } else {
    // Новый лимит посреди ТЕКУЩЕГО месяца считается с сегодняшнего дня,
    // в будущем или прошлом месяце — с 1-го числа
    const { from, to } = monthBounds(plan.month);
    const today = todayISO();
    const since = today > from && today <= to ? today : from;
    plan.limits.push({ categoryId, period, amount, since });
  }
}
export function removeLimit(plan, categoryId) {
  plan.limits = plan.limits.filter((l) => l.categoryId !== categoryId);
}

// ---------------------------------------------------------------------
// Расчёты
// ---------------------------------------------------------------------
/** Ставка в день (копейки, может быть дробной) или null для месячного. */
export function dailyRate(limit) {
  if (limit.period === 'day') return limit.amount;
  if (limit.period === 'week') return limit.amount / 7;
  return null;
}

/** Сколько лимит «съедает» из бюджета за месяц. */
export function monthAllocation(limit, key) {
  if (limit.period === 'month') return limit.amount;
  const { to } = monthBounds(key);
  const days = daysBetween(limit.since, to) + 1;
  return Math.round(dailyRate(limit) * Math.max(0, days));
}

/** Сводка плана: на траты, распределено по лимитам, свободно. */
export function planSummary(plan, categories) {
  const active = activeLimits(plan, categories);
  const available = plan.income - plan.savings;
  const allocated = active.reduce((s, l) => s + monthAllocation(l, plan.month), 0);
  return { available, allocated, free: available - allocated };
}

/** Лимиты только по существующим, не скрытым категориям. */
export function activeLimits(plan, categories) {
  return plan.limits.filter((l) => {
    const c = categories.find((x) => x.id === l.categoryId);
    return c && !c.archived;
  });
}

/** Сумма трат категории за даты [from, to]. */
function spentIn(transactions, categoryId, from, to) {
  let s = 0;
  for (const t of transactions) {
    if (t.type === 'expense' && t.categoryId === categoryId && t.date >= from && t.date <= to) s += t.amount;
  }
  return s;
}
/** Траты в категориях без своего лимита за [from, to]. */
function spentOther(transactions, limitedIds, from, to) {
  let s = 0;
  for (const t of transactions) {
    if (t.type === 'expense' && !limitedIds.has(t.categoryId) && t.date >= from && t.date <= to) s += t.amount;
  }
  return s;
}

/**
 * Состояние на сегодня (для главного экрана).
 * monthTx — все траты текущего месяца.
 */
export function todayState(plan, categories, monthTx) {
  const today = todayISO();
  const yesterday = yesterdayISO();
  const { from } = monthBounds(plan.month);
  const rows = [];

  for (const l of activeLimits(plan, categories)) {
    const category = categories.find((c) => c.id === l.categoryId);
    if (l.period === 'month') {
      const spent = spentIn(monthTx, l.categoryId, from, today);
      rows.push({ kind: 'month', limit: l, category, spent, total: l.amount, remaining: l.amount - spent });
      continue;
    }
    if (l.since > today) continue;
    const rate = dailyRate(l);
    const daysBefore = Math.max(0, daysBetween(l.since, today)); // полных дней до сегодня
    const spentBefore = spentIn(monthTx, l.categoryId, l.since, yesterday);
    const base = Math.round(rate);
    const todayLimit = Math.round(rate * (daysBefore + 1)) - spentBefore;
    const carry = todayLimit - base; // + экономия прошлых дней, − перерасход
    const spentToday = spentIn(monthTx, l.categoryId, today, today);
    rows.push({ kind: 'daily', limit: l, category, base, carry, todayLimit, spent: spentToday, remaining: todayLimit - spentToday });
  }

  let other = null;
  if (plan.income > 0) {
    const ids = new Set(activeLimits(plan, categories).map((l) => l.categoryId));
    const { free } = planSummary(plan, categories);
    const spent = spentOther(monthTx, ids, from, today);
    other = { spent, total: free, remaining: free - spent };
  }
  return { rows, other };
}

/**
 * Итоги месяца по плану.
 * upto — по какой день считать (для прошедшего месяца — последний день).
 * Для каждого лимита: выделено, потрачено, разница (+ экономия / − превышение).
 */
export function monthResult(plan, categories, monthTx, upto) {
  const { from, to } = monthBounds(plan.month);
  if (upto > to) upto = to;
  const finished = upto === to;
  const rows = [];

  for (const l of activeLimits(plan, categories)) {
    const category = categories.find((c) => c.id === l.categoryId);
    let allocated;
    if (l.period === 'month') {
      if (!finished) continue; // месячный лимит подводим только в конце месяца
      allocated = l.amount;
    } else {
      if (l.since > upto) continue;
      allocated = Math.round(dailyRate(l) * (daysBetween(l.since, upto) + 1));
    }
    const start = l.period === 'month' || l.since < from ? from : l.since;
    const spent = spentIn(monthTx, l.categoryId, start, upto);
    rows.push({ limit: l, category, allocated, spent, diff: allocated - spent });
  }

  let other = null;
  if (plan.income > 0 && finished) {
    const ids = new Set(activeLimits(plan, categories).map((l) => l.categoryId));
    const { free } = planSummary(plan, categories);
    const spent = spentOther(monthTx, ids, from, to);
    other = { allocated: free, spent, diff: free - spent };
  }

  const all = [...rows, ...(other ? [other] : [])];
  const saved = all.reduce((s, r) => s + Math.max(0, r.diff), 0);
  const over = all.reduce((s, r) => s + Math.max(0, -r.diff), 0);
  const totalSpent = monthTx.filter((t) => t.type === 'expense' && t.date <= upto).reduce((s, t) => s + t.amount, 0);
  return { rows, other, saved, over, finished, totalSpent };
}

// ---------------------------------------------------------------------
// Переход со старых лимитов (версия 5.x) на план
// ---------------------------------------------------------------------
export async function migrateOldLimits() {
  const plans = (await db.getAll('settings')).filter((s) => s.id.startsWith('plan:'));
  if (plans.length) return;
  const cats = await db.getAll('categories');
  const key = currentMonthKey();
  const { from } = monthBounds(key);
  const limits = [];
  for (const c of cats) {
    if (c.type !== 'expense' || c.archived) continue;
    const dl = (c.dailyLimits || []);
    const last = dl[dl.length - 1];
    if (last && last.amount > 0) {
      limits.push({ categoryId: c.id, period: 'day', amount: last.amount, since: last.from > from ? last.from : from });
    } else if (c.limit > 0) {
      limits.push({ categoryId: c.id, period: 'month', amount: c.limit, since: from });
    }
  }
  if (limits.length) await savePlan({ id: 'plan:' + key, month: key, income: 0, savings: 0, limits });
}

export { addDays };

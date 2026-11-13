// =====================================================================
// budget.js — план «конвертами» (как в YNAB). Только расчёты.
//
// Идея: распределяем только те деньги, которые уже есть.
//   Готово к распределению = Мои деньги − всё, что лежит в конвертах
//                            − то, что уже назначено на будущие месяцы.
//   У каждой категории (конверта) в месяце:
//     осталось = остаток с прошлого месяца + назначено − потрачено.
//   Остаток переходит на следующий месяц сам. Перерасход (минус) на
//   следующий месяц не переходит — он уменьшает «Готово к распределению».
//
// Хранение (таблица settings):
//   { id: 'budget', start: 'ГГГГ-ММ', groups: [{ id, name }] }
//   { id: 'asg:ГГГГ-ММ', month, amounts: { [categoryId]: копейки } }
// В категории:
//   group:  id группы
//   target: { type: 'day'|'week'|'month'|'goal', amount, weekdays?, date?, since? }
//     day   — N в день (weekdays: [пн…вс] — разные суммы по дням недели)
//     week  — N в неделю
//     month — N в месяц
//     goal  — накопить N (к дате date — тогда считаем, сколько нужно в месяц)
// =====================================================================

import * as db from './db.js';
import { getBalances } from './wallet.js';
import { listRecurring, occurrences } from './recurring.js';
import {
  monthRange, todayISO, yesterdayISO, addDays, daysBetween, now, MONTHS,
} from './utils.js';

export const DEFAULT_GROUPS = [
  { id: 'g-must', name: 'Обязательное' },
  { id: 'g-daily', name: 'Повседневное' },
  { id: 'g-goals', name: 'Цели' },
];

// ---------------------------------------------------------------------
// Месяцы
// ---------------------------------------------------------------------
export function monthKeyOf(x) {
  if (typeof x === 'string') return x.slice(0, 7);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
}
export const currentMonthKey = () => monthKeyOf(now());
export function monthBounds(key) {
  const [y, m] = key.split('-').map(Number);
  return monthRange(y, m - 1);
}
export function shiftMonthKey(key, delta) {
  const [y, m] = key.split('-').map(Number);
  return monthKeyOf(new Date(y, m - 1 + delta, 1));
}
export const monthName = (key) => MONTHS[Number(key.slice(5, 7)) - 1];
const MONTHS_GEN_L = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
const MONTHS_TO = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const monthPrep = (key) => MONTHS_PREP[Number(key.slice(5, 7)) - 1];
export function goalDateLabel(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS_TO[m - 1]}`;
}
function monthsBetween(a, b) { // сколько месяцев от a до b (ГГГГ-ММ)
  const [y1, m1] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

// ---------------------------------------------------------------------
// Настройки плана и группы
// ---------------------------------------------------------------------
export async function getMeta() {
  let meta = await db.get('settings', 'budget');
  if (!meta) {
    meta = { id: 'budget', start: currentMonthKey(), groups: DEFAULT_GROUPS.map((g) => ({ ...g })) };
    await db.put('settings', meta);
  }
  return meta;
}
export async function saveMeta(meta) { await db.put('settings', meta); }

/** Группа категории (если не задана или удалена — «Повседневное» или первая). */
export function groupOf(cat, groups) {
  if (cat.group && groups.some((g) => g.id === cat.group)) return cat.group;
  return (groups.find((g) => g.id === 'g-daily') || groups[0]).id;
}

// ---------------------------------------------------------------------
// Назначено
// ---------------------------------------------------------------------
async function allAssignments() {
  const map = {};
  for (const r of await db.getAll('settings')) if (r.id.startsWith('asg:')) map[r.month] = r.amounts || {};
  return map;
}
export async function getAssigned(key) {
  const r = await db.get('settings', 'asg:' + key);
  return r ? { ...r.amounts } : {};
}
export async function setAssignedMany(key, amounts) {
  const clean = {};
  for (const [id, v] of Object.entries(amounts)) if (v) clean[id] = Math.round(v);
  await db.put('settings', { id: 'asg:' + key, month: key, amounts: clean });
  // План начинается с самого раннего месяца, где что-то назначили
  const meta = await getMeta();
  if (key < meta.start && Object.keys(clean).length) { meta.start = key; await saveMeta(meta); }
}
export async function setAssigned(key, categoryId, amount) {
  const a = await getAssigned(key);
  a[categoryId] = amount;
  await setAssignedMany(key, a);
}
/** Перенести деньги между конвертами (from = null — из «Готово к распределению»). */
export async function moveMoney(key, fromId, toId, amount) {
  const a = await getAssigned(key);
  if (fromId) a[fromId] = (a[fromId] || 0) - amount;
  a[toId] = (a[toId] || 0) + amount;
  await setAssignedMany(key, a);
}

// ---------------------------------------------------------------------
// Цели
// ---------------------------------------------------------------------
function weekdayIndex(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(y, m - 1, d, 12).getDay() + 6) % 7; // 0 — пн
}
/** Сколько цель «в день/в неделю» разрешает на конкретный день. */
export function rateOn(target, iso) {
  if (target.type === 'week') return target.amount / 7;
  if (target.weekdays) return target.weekdays[weekdayIndex(iso)];
  return target.amount;
}
export function allowedBetween(target, from, to) {
  let sum = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) sum += rateOn(target, d);
  return Math.round(sum);
}
export const isDaily = (t) => !!t && (t.type === 'day' || t.type === 'week');

/** Сколько нужно назначить в месяце по цели. carryIn — что лежало в конверте на 1-е число. */
export function targetNeed(target, key, carryIn) {
  if (!target) return 0;
  const { from, to } = monthBounds(key);
  if (target.type === 'month') return target.amount;
  if (isDaily(target)) {
    // Цель, поставленная посреди месяца, считается с того дня
    const start = target.since && target.since > from ? target.since : from;
    return start > to ? 0 : allowedBetween(target, start, to);
  }
  if (target.type === 'goal') {
    const left = target.amount - Math.max(0, carryIn);
    if (left <= 0) return 0;
    if (!target.date) return 0;
    const months = monthsBetween(key, monthKeyOf(target.date)) + 1;
    if (months <= 0) return left;
    return Math.ceil(left / months / 100) * 100; // до рубля вверх
  }
  return 0;
}

export function targetLabel(t, fmt) {
  if (!t) return '';
  if (t.type === 'day') {
    if (t.weekdays) {
      const w = t.weekdays;
      if (w.slice(0, 5).every((x) => x === w[0]) && w[5] === w[6]) return `${fmt(w[0])} будни · ${fmt(w[5])} выходные`;
      return `${fmt(Math.round(w.reduce((a, b) => a + b, 0) / 7))} в день`;
    }
    return `${fmt(t.amount)} в день`;
  }
  if (t.type === 'week') return `${fmt(t.amount)} в неделю`;
  if (t.type === 'month') return `${fmt(t.amount)} в месяц`;
  if (t.type === 'goal') return t.date ? `${fmt(t.amount)} к ${goalDateLabel(t.date)}` : `цель ${fmt(t.amount)}`;
  return '';
}

// ---------------------------------------------------------------------
// Главный расчёт
// ---------------------------------------------------------------------
/** Траты по месяцам и категориям: { 'ГГГГ-ММ': { catId: копейки } } */
function spentMap(transactions) {
  const map = {};
  for (const t of transactions) {
    if (t.type !== 'expense' || t.ownTransfer) continue;
    const k = t.date.slice(0, 7);
    (map[k] ||= {})[t.categoryId] = (map[k][t.categoryId] || 0) + t.amount;
  }
  return map;
}

/**
 * Состояние плана на месяц key.
 * Возвращает { key, meta, groups: [{ id, name, assigned, rows: [row] }],
 *              rows, rta, money, assignedTotal, spentTotal, overspent, started }
 * row: { cat, group, carry, assigned, spent, available, target, need, status }
 */
export async function computeBudget(key) {
  const meta = await getMeta();
  const cats = (await db.getAll('categories'))
    .filter((c) => c.type === 'expense' && !c.archived)
    .sort((a, b) => a.order - b.order);
  const txs = await db.getAll('transactions');
  const spent = spentMap(txs);
  const asg = await allAssignments();
  const cur = currentMonthKey();

  // Остатки по месяцам от начала плана до нужного (и до текущего — для «Готово к распределению»)
  const last = key > cur ? key : cur;
  const avail = {};   // остаток на конец просмотренного месяца
  const atKey = {};   // данные именно для месяца key
  const atCur = {};   // остаток в текущем месяце
  for (const c of cats) {
    let a = 0;
    let m = meta.start < key ? meta.start : key;
    for (let i = 0; m <= last && i < 600; i++, m = shiftMonthKey(m, 1)) {
      const carry = m > meta.start ? Math.max(0, a) : 0;
      const as = (asg[m] && asg[m][c.id]) || 0;
      const sp = (spent[m] && spent[m][c.id]) || 0;
      a = carry + as - sp;
      if (m === key) atKey[c.id] = { carry, assigned: as, spent: sp, available: a };
      if (m === cur) atCur[c.id] = a;
    }
    avail[c.id] = a;
  }

  // Готово к распределению
  const { balance } = await getBalances();
  let rta = null;
  if (balance !== null) {
    let reserved = 0;
    for (const c of cats) reserved += atCur[c.id] || 0;
    for (const [m, amounts] of Object.entries(asg)) {
      if (m > cur) for (const [id, v] of Object.entries(amounts)) if (cats.some((c) => c.id === id)) reserved += v;
    }
    rta = balance - reserved;
  }

  // Регулярные платежи этого месяца — по категориям (для подсказок)
  const { from, to } = monthBounds(key);
  const recByCat = {};
  for (const r of await listRecurring()) {
    if (r.type !== 'expense') continue;
    for (const d of occurrences(r, from, to)) (recByCat[r.categoryId] ||= []).push({ rec: r, date: d });
  }

  const rows = cats.map((c) => {
    const k = atKey[c.id] || { carry: 0, assigned: 0, spent: 0, available: 0 };
    const target = c.target || null;
    const need = targetNeed(target, key, k.carry);
    let status = 'ok';
    if (k.available < 0) status = 'bad';
    else if (target && target.type !== 'goal' && k.assigned + k.carry < need) status = 'warn';
    else if (target && target.type === 'goal' && need > 0 && k.assigned < need) status = 'warn';
    else if (k.available === 0) status = 'zero';
    return {
      cat: c, group: groupOf(c, meta.groups), target, need, status,
      recurring: (recByCat[c.id] || []).sort((a, b) => a.date.localeCompare(b.date)), ...k,
    };
  });

  const groups = meta.groups.map((g) => {
    const gr = rows.filter((r) => r.group === g.id);
    return { ...g, rows: gr, assigned: gr.reduce((s, r) => s + r.assigned, 0) };
  });

  return {
    key, meta, groups, rows, rta, money: balance,
    assignedTotal: rows.reduce((s, r) => s + r.assigned, 0),
    spentTotal: rows.reduce((s, r) => s + r.spent, 0),
    overspent: rows.filter((r) => r.available < 0),
    started: Object.keys(asg).some((m) => Object.keys(asg[m]).length),
  };
}

/**
 * «Сегодня можно» по целям «в день / в неделю» (только текущий месяц).
 * Экономия прошлых дней прибавляется, перерасход — вычитается; но не больше,
 * чем реально лежит в конверте.
 */
export function todayRows(budget) {
  const today = todayISO();
  const yesterday = yesterdayISO();
  const { from } = monthBounds(budget.key);
  const res = budget.rows.filter((r) => {
    if (!isDaily(r.target)) return false;
    const start = r.target.since && r.target.since > from ? r.target.since : from;
    return start <= today;
  });
  return res.map((r) => {
    const start = r.target.since && r.target.since > from ? r.target.since : from;
    const spentBefore = r.spentByDay ? sumDays(r.spentByDay, start, yesterday) : 0;
    const spentToday = r.spentByDay ? (r.spentByDay[today] || 0) : 0;
    const base = Math.round(rateOn(r.target, today));
    let todayLimit = allowedBetween(r.target, start, today) - spentBefore;
    // Не больше, чем осталось в конверте (с учётом сегодняшних трат)
    todayLimit = Math.min(todayLimit, r.available + spentToday);
    return {
      row: r, category: r.cat, base, carry: todayLimit - base, todayLimit,
      spent: spentToday, remaining: todayLimit - spentToday, target: r.target,
    };
  });
}
function sumDays(map, from, to) {
  let s = 0;
  for (const [d, v] of Object.entries(map)) if (d >= from && d <= to) s += v;
  return s;
}

/** Добавить к строкам траты по дням текущего месяца (нужно для «Сегодня можно»). */
export async function withDailySpending(budget) {
  const { from, to } = monthBounds(budget.key);
  const txs = await db.getTransactionsBetween(from, to);
  for (const r of budget.rows) {
    if (!isDaily(r.target)) continue;
    r.spentByDay = {};
    for (const t of txs) {
      if (t.type === 'expense' && !t.ownTransfer && t.categoryId === r.cat.id) r.spentByDay[t.date] = (r.spentByDay[t.date] || 0) + t.amount;
    }
  }
  return budget;
}

/** Сколько дней осталось в месяце, включая сегодня (для текущего месяца). */
export function daysLeft(key) {
  const { from, to } = monthBounds(key);
  const today = todayISO();
  if (today > to) return 0;
  return daysBetween(today < from ? from : today, to) + 1;
}

// ---------------------------------------------------------------------
// Автораспределение
// ---------------------------------------------------------------------
/** mode: 'targets' | 'last-assigned' | 'last-spent' | 'reset'. Возвращает прежние суммы (для отмены). */
export async function autoAssign(key, mode) {
  const before = await getAssigned(key);
  const b = await computeBudget(key);
  const next = { ...before };
  if (mode === 'reset') {
    for (const r of b.rows) delete next[r.cat.id];
  } else if (mode === 'targets') {
    for (const r of b.rows) {
      const need = r.target && r.target.type !== 'goal' ? r.need - r.carry : r.need;
      if (need > r.assigned) next[r.cat.id] = need;
    }
  } else {
    const prev = shiftMonthKey(key, -1);
    const pb = await computeBudget(prev);
    for (const r of pb.rows) {
      const v = mode === 'last-assigned' ? r.assigned : r.spent;
      if (v > 0) next[r.cat.id] = v;
    }
  }
  await setAssignedMany(key, next);
  return before;
}

/** Сколько добавит «По целям» — для подписи в меню. */
export function targetsShortfall(b) {
  let s = 0;
  for (const r of b.rows) {
    const need = r.target && r.target.type !== 'goal' ? r.need - r.carry : r.need;
    if (need > r.assigned) s += need - r.assigned;
  }
  return s;
}

// ---------------------------------------------------------------------
// Переход со старых планов (лимиты, шаблоны) — один раз
// ---------------------------------------------------------------------
const MUST = /(подписк|связь|телефон|интернет|квартир|аренд|жкх|коммун|кредит|ипотек|страхов)/i;

export async function migrateToBudget() {
  if (await db.get('settings', 'budget')) return false;
  const { getPlan, monthAllocation, refreshCurrentSnapshot } = await import('./plan.js');
  const key = currentMonthKey();
  const meta = { id: 'budget', start: key, groups: DEFAULT_GROUPS.map((g) => ({ ...g })), migratedAt: Date.now() };
  await refreshCurrentSnapshot();
  const plan = await getPlan(key);
  const cats = await db.getAll('categories');
  const recs = (await listRecurring()).filter((r) => r.type === 'expense');
  const { from, to } = monthBounds(key);
  const amounts = {};

  for (const c of cats) {
    if (c.type !== 'expense') continue;
    const catRecs = recs.filter((r) => r.categoryId === c.id);
    c.group = c.group || (catRecs.length || MUST.test(c.name) ? 'g-must' : 'g-daily');
    const limit = plan && plan.limits.find((l) => l.categoryId === c.id);
    if (limit) {
      c.target = { type: limit.period, amount: limit.amount };
      if (limit.weekdays) c.target.weekdays = [...limit.weekdays];
      if (limit.since && limit.since > from) c.target.since = limit.since;
      amounts[c.id] = monthAllocation(limit, key);
    }
    // Регулярные платежи — сумма этого месяца в их категорию
    const recSum = catRecs.reduce((s, r) => s + occurrences(r, from, to).length * r.amount, 0);
    if (recSum) {
      amounts[c.id] = (amounts[c.id] || 0) + recSum;
      if (!c.target) c.target = { type: 'month', amount: recSum };
    }
    await db.put('categories', c);
  }
  await db.put('settings', meta);
  if (Object.keys(amounts).length) await setAssignedMany(key, amounts);
  return true;
}

// =====================================================================
// plan.js — план на месяц (мастер-лимит) и лимиты по категориям.
// Здесь только расчёты, без интерфейса.
//
// Хранение (таблица settings):
//
//  Шаблон плана — то, что вы составляете один раз:
//  { id: 'tpl:…', name: 'Обычный месяц',
//    income: 2000000, savings: 500000,          // копейки
//    limits: [{ categoryId, period: 'day'|'week'|'month', amount }] }
//
//  Месяц — какой шаблон в нём выбран и копия плана на память:
//  { id: 'plan:2026-11', month: '2026-11', templateId: 'tpl:…',
//    since: { [categoryId]: 'ГГГГ-ММ-ДД' },     // лимит, добавленный посреди месяца
//    snapshot: { name, income, savings, limits } }
//
//  • Текущий и будущие месяцы берут значения из шаблона «вживую»:
//    поменяли шаблон — поменялись и они.
//  • Прошлые месяцы используют свою копию (snapshot), поэтому их итоги
//    не меняются, если потом отредактировать шаблон.
//  • Если у месяца нет своей записи — он берёт шаблон прошлого месяца.
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
import { mandatoryForMonth } from './recurring.js';
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
// Шаблоны планов
// ---------------------------------------------------------------------
export async function listTemplates() {
  return (await db.getAll('settings'))
    .filter((x) => x.id.startsWith('tpl:'))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
export async function getTemplate(id) {
  return id ? db.get('settings', id) : null;
}
export function newTemplate(name, from = null) {
  return {
    id: 'tpl:' + db.newId(), name, createdAt: Date.now(),
    income: from ? from.income : 0,
    savings: from ? from.savings : 0,
    limits: from ? from.limits.map(cleanLimit) : [],
  };
}
export async function saveTemplate(t) {
  await db.put('settings', t);
  // Обновляем копию плана текущего месяца, если он на этом шаблоне
  await refreshCurrentSnapshot();
}
export async function deleteTemplate(id) {
  await db.remove('settings', id);
}

/** Месяцы (текущий и будущие), где выбран этот шаблон. */
export async function monthsUsing(templateId) {
  const cur = currentMonthKey();
  const recs = await monthRecords();
  const res = [];
  // Текущий месяц может использовать шаблон по наследству
  if ((await resolveTemplateId(cur)) === templateId) res.push(cur);
  for (const r of recs) if (r.month > cur && r.templateId === templateId) res.push(r.month);
  return res;
}

// ---------------------------------------------------------------------
// Записи месяцев
// ---------------------------------------------------------------------
async function monthRecords() {
  return (await db.getAll('settings'))
    .filter((x) => x.id.startsWith('plan:'))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** Своя запись месяца или ближайшая более ранняя. */
async function recordFor(key) {
  const recs = await monthRecords();
  let found = null;
  for (const r of recs) if (r.month <= key) found = r;
  return found;
}

/** Какой шаблон действует в месяце. */
export async function resolveTemplateId(key) {
  const r = await recordFor(key);
  return r ? r.templateId : null;
}

/** Собрать план месяца из значений (шаблона или копии) и дат «since». */
function buildPlan(key, values, rec, extra = {}) {
  const { from } = monthBounds(key);
  const own = rec && rec.month === key;
  return {
    month: key,
    name: values.name,
    income: values.income,
    savings: values.savings,
    limits: values.limits.map((l) => ({
      ...l,
      since: (own && rec.since && rec.since[l.categoryId]) || from,
    })),
    ...extra,
  };
}

/**
 * План на месяц или null.
 * Поля: month, name, templateId, income, savings, limits (с since),
 *       inherited (своей записи нет), past (месяц прошёл — копия).
 */
export async function getPlan(key) {
  const plan = await getPlanRaw(key);
  // Обязательные траты — регулярные платежи, которые выпадают на этот месяц
  if (plan) plan.mandatory = await mandatoryForMonth(key);
  return plan;
}

async function getPlanRaw(key) {
  const cur = currentMonthKey();
  const rec = await recordFor(key);
  if (!rec) return null;
  const own = rec.month === key;

  if (key < cur) {
    // Прошлый месяц — по копии, которая была сохранена тогда
    if (!rec.snapshot) return null;
    return buildPlan(key, rec.snapshot, rec, { templateId: rec.templateId, inherited: !own, past: true });
  }
  const t = await getTemplate(rec.templateId);
  if (!t) return rec.snapshot ? buildPlan(key, rec.snapshot, rec, { templateId: null, inherited: !own }) : null;
  return buildPlan(key, t, rec, { templateId: t.id, inherited: !own });
}

/** Сохранить копию плана в запись текущего месяца (создать запись, если нужно). */
export async function refreshCurrentSnapshot() {
  const cur = currentMonthKey();
  const rec = await recordFor(cur);
  if (!rec) return;
  const t = await getTemplate(rec.templateId);
  if (!t) return;
  const own = rec.month === cur ? rec : { id: 'plan:' + cur, month: cur, templateId: rec.templateId, since: {} };
  own.snapshot = { name: t.name, income: t.income, savings: t.savings, limits: t.limits };
  await db.put('settings', own);
}

/** Выбрать шаблон для месяца (действует и на следующие месяцы без своей записи). */
export async function applyTemplate(key, templateId) {
  const existing = await db.get('settings', 'plan:' + key);
  const rec = existing || { id: 'plan:' + key, month: key, since: {} };
  rec.templateId = templateId;
  if (key < currentMonthKey()) {
    const t = await getTemplate(templateId);
    rec.snapshot = { name: t.name, income: t.income, savings: t.savings, limits: t.limits };
  }
  await db.put('settings', rec);
  await refreshCurrentSnapshot();
}

// ---------------------------------------------------------------------
// Редактирование (вкладка «Лимит»)
// ---------------------------------------------------------------------
/**
 * План для редактирования.
 *  mode 'template' — правим шаблон (текущий и будущие месяцы);
 *  mode 'snapshot' — прошлый месяц: правим только его копию.
 * Если шаблона ещё нет — создаём новый «Мой план» (сохранится при «Готово»).
 */
export async function getPlanForEdit(key = currentMonthKey()) {
  const plan = await getPlan(key);
  const past = key < currentMonthKey();
  if (plan && past) return { ...plan, mode: 'snapshot' };
  if (plan && plan.templateId) return { ...plan, mode: 'template' };
  // Шаблона нет (ещё не создан или удалён) — новый, со значениями плана, если были
  const t = newTemplate((await listTemplates()).length ? 'Новый план' : 'Мой план', plan);
  return { ...buildPlan(key, t, null), templateId: t.id, mode: past ? 'snapshot' : 'template', isNew: true, createdAt: t.createdAt };
}

/** Сохранить результат редактирования. */
export async function savePlan(plan) {
  const key = plan.month;
  const { from } = monthBounds(key);
  const values = {
    income: plan.income,
    savings: plan.savings,
    limits: plan.limits.map(cleanLimit),
  };
  // Даты «since» (лимит добавлен посреди месяца) храним в записи месяца
  const since = {};
  for (const l of plan.limits) if (l.since && l.since > from) since[l.categoryId] = l.since;

  const existing = await db.get('settings', 'plan:' + key);
  const rec = existing || { id: 'plan:' + key, month: key };
  rec.since = since;

  if (plan.mode === 'snapshot') {
    rec.templateId = rec.templateId || plan.templateId || null;
    rec.snapshot = { name: plan.name, ...values };
    await db.put('settings', rec);
    return;
  }
  const t = (await getTemplate(plan.templateId))
    || { id: plan.templateId, name: plan.name, createdAt: plan.createdAt || Date.now() };
  Object.assign(t, values);
  await db.put('settings', t);
  rec.templateId = t.id;
  await db.put('settings', rec);
  await refreshCurrentSnapshot();
}

/** Лимит без служебных полей (since) — для хранения в шаблоне. */
export function cleanLimit(l) {
  const c = { categoryId: l.categoryId, period: l.period, amount: l.amount };
  if (l.weekdays) c.weekdays = [...l.weekdays];
  return c;
}

/**
 * Добавить или изменить лимит категории в плане (без сохранения).
 * weekdays — разные суммы по дням недели [пн, вт, ср, чт, пт, сб, вс] (копейки).
 */
export function setLimit(plan, categoryId, period, amount, weekdays = null) {
  if (weekdays) {
    period = 'day';
    amount = Math.round(weekdays.reduce((a, b) => a + b, 0) / 7); // в среднем в день
  }
  const existing = plan.limits.find((l) => l.categoryId === categoryId);
  if (existing) {
    existing.period = period;
    existing.amount = amount;
    if (weekdays) existing.weekdays = weekdays; else delete existing.weekdays;
  } else {
    // Новый лимит посреди ТЕКУЩЕГО месяца считается с сегодняшнего дня,
    // в будущем или прошлом месяце — с 1-го числа
    const { from, to } = monthBounds(plan.month);
    const today = todayISO();
    const since = today > from && today <= to ? today : from;
    plan.limits.push({ categoryId, period, amount, since, ...(weekdays ? { weekdays } : {}) });
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

/** Номер дня недели: 0 — понедельник … 6 — воскресенье. */
function weekdayIndex(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(y, m - 1, d, 12).getDay() + 6) % 7;
}

/** Лимит на конкретный день (с учётом разных сумм по дням недели). */
export function rateOn(limit, iso) {
  if (limit.weekdays) return limit.weekdays[weekdayIndex(iso)];
  return dailyRate(limit);
}

/** Сколько лимит разрешает потратить за даты [from, to] включительно. */
export function allowedBetween(limit, from, to) {
  if (to < from) return 0;
  if (!limit.weekdays) return Math.round(dailyRate(limit) * (daysBetween(from, to) + 1));
  let sum = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) sum += rateOn(limit, d);
  return sum;
}

/** Подпись лимита: «300 ₽ в день», «2 100 ₽ в неделю», «300 ₽ будни · 500 ₽ выходные». */
export function limitLabel(l, fmt) {
  if (l.weekdays) {
    const w = l.weekdays;
    const weekdaysSame = w.slice(0, 5).every((x) => x === w[0]);
    if (weekdaysSame && w[5] === w[6]) return `${fmt(w[0])} будни · ${fmt(w[5])} выходные`;
    return `по дням недели · ${fmt(w.reduce((a, b) => a + b, 0))} в неделю`;
  }
  return `${fmt(l.amount)} ${PERIODS[l.period].short}`;
}

/** Сколько лимит «съедает» из бюджета за месяц. */
export function monthAllocation(limit, key) {
  if (limit.period === 'month') return limit.amount;
  const { to } = monthBounds(key);
  return allowedBetween(limit, limit.since, to);
}

/** Сводка плана: на траты, распределено по лимитам, свободно. */
export function planSummary(plan, categories) {
  const active = activeLimits(plan, categories);
  const available = plan.income - plan.savings;
  const allocated = active.reduce((s, l) => s + monthAllocation(l, plan.month), 0);
  const mandatory = plan.mandatory || 0; // регулярные платежи
  return { available, allocated, mandatory, free: available - allocated - mandatory };
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
    // Регулярные платежи идут в «обязательные», а не в лимит категории
    if (t.type === 'expense' && !t.recurringId && t.categoryId === categoryId && t.date >= from && t.date <= to) s += t.amount;
  }
  return s;
}
/** Траты в категориях без своего лимита за [from, to] (без регулярных платежей). */
function spentOther(transactions, limitedIds, from, to) {
  let s = 0;
  for (const t of transactions) {
    if (t.type === 'expense' && !t.recurringId && !limitedIds.has(t.categoryId) && t.date >= from && t.date <= to) s += t.amount;
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
    const spentBefore = spentIn(monthTx, l.categoryId, l.since, yesterday);
    const base = Math.round(rateOn(l, today));              // лимит именно на сегодня
    const todayLimit = allowedBetween(l, l.since, today) - spentBefore;
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
      allocated = allowedBetween(l, l.since, upto);
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

  // Обязательные (регулярные) платежи: запланировано и сколько ушло
  let mandatory = null;
  if (finished && plan.mandatory > 0) {
    const spentM = monthTx.filter((t) => t.type === 'expense' && t.recurringId && t.date >= from && t.date <= to).reduce((s, t) => s + t.amount, 0);
    mandatory = { allocated: plan.mandatory, spent: spentM, diff: plan.mandatory - spentM };
  }

  const all = [...rows, ...(other ? [other] : []), ...(mandatory ? [mandatory] : [])];
  const saved = all.reduce((s, r) => s + Math.max(0, r.diff), 0);
  const over = all.reduce((s, r) => s + Math.max(0, -r.diff), 0);
  const totalSpent = monthTx.filter((t) => t.type === 'expense' && t.date <= upto).reduce((s, t) => s + t.amount, 0);
  return { rows, other, mandatory, saved, over, finished, totalSpent };
}

// ---------------------------------------------------------------------
// Переходы со старых версий
// ---------------------------------------------------------------------
/** 5.x: лимиты хранились в категориях → шаблон «Мой план». */
export async function migrateOldLimits() {
  const all = await db.getAll('settings');
  if (all.some((x) => x.id.startsWith('plan:') || x.id.startsWith('tpl:'))) return;
  const cats = await db.getAll('categories');
  const key = currentMonthKey();
  const { from } = monthBounds(key);
  const limits = [];
  const since = {};
  for (const c of cats) {
    if (c.type !== 'expense' || c.archived) continue;
    const dl = (c.dailyLimits || []);
    const last = dl[dl.length - 1];
    if (last && last.amount > 0) {
      limits.push({ categoryId: c.id, period: 'day', amount: last.amount });
      if (last.from > from) since[c.id] = last.from;
    } else if (c.limit > 0) {
      limits.push({ categoryId: c.id, period: 'month', amount: c.limit });
    }
  }
  if (!limits.length) return;
  const t = { ...newTemplate('Мой план'), limits };
  await db.put('settings', t);
  await db.put('settings', { id: 'plan:' + key, month: key, templateId: t.id, since });
  await refreshCurrentSnapshot();
}

/** 6.1: план хранился прямо в записи месяца → шаблоны. */
export async function migratePlansToTemplates() {
  const recs = (await monthRecords()).filter((r) => !('templateId' in r) && 'income' in r);
  if (!recs.length) return;
  const same = (a, b) => JSON.stringify([a.income, a.savings, a.limits.map(cleanLimit)])
    === JSON.stringify([b.income, b.savings, b.limits.map(cleanLimit)]);
  let prev = null;
  let n = 0;
  for (const r of recs) {
    const { from } = monthBounds(r.month);
    let t = prev && same(prev, r) ? prev : null;
    if (!t) {
      t = newTemplate(n === 0 ? 'Мой план' : `План (${MONTHS_LOWER[Number(r.month.slice(5)) - 1]})`, r);
      t.createdAt = Date.now() + n++;
      await db.put('settings', t);
    }
    const since = {};
    for (const l of r.limits) if (l.since && l.since > from) since[l.categoryId] = l.since;
    await db.put('settings', {
      id: r.id, month: r.month, templateId: t.id, since,
      snapshot: { name: t.name, income: r.income, savings: r.savings, limits: t.limits },
    });
    prev = t;
  }
}
const MONTHS_LOWER = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

export { addDays };

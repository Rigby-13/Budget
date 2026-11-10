// =====================================================================
// stats.js — вкладка «Статистика»: итоги за период, диаграмма по
// категориям, динамика по месяцам, лимиты.
// =====================================================================

import * as db from './db.js';
import {
  formatMoney, formatMoneyShort, toISODate, fromISODate, todayISO, monthRange,
  startOfWeek, rangeLabel, daysBetween, MONTHS, MONTHS_SHORT, escapeHTML,
} from './utils.js';
import { $, toast } from './ui.js';
import { openCategories } from './categories.js';

// Цвета категорий: 8 проверенных на различимость (в том числе при
// дальтонизме) оттенков. Цвет закреплён за категорией по её месту
// в списке, поэтому «Еда» всегда одного цвета. 9-я и дальше — серые.
const SLOTS = 8;
function colorVar(index) {
  return index < SLOTS ? `var(--c${index + 1})` : 'var(--c-other)';
}

const now = new Date();
const state = {
  mode: 'month',            // 'week' | 'month' | 'year' | 'custom'
  anchor: now,              // любая дата внутри выбранного периода
  customFrom: monthRange(now.getFullYear(), now.getMonth()).from,
  customTo: todayISO(),
  breakdown: 'expense',     // чью разбивку показываем: расходы или доходы
  selectedMonth: null,      // выбранный столбик в динамике ('ГГГГ-ММ')
};

// =====================================================================
// ПЕРИОД
// =====================================================================
function currentRange() {
  const a = state.anchor;
  if (state.mode === 'week') {
    const from = startOfWeek(a);
    const to = new Date(from); to.setDate(to.getDate() + 6);
    return { from: toISODate(from), to: toISODate(to) };
  }
  if (state.mode === 'month') return monthRange(a.getFullYear(), a.getMonth());
  if (state.mode === 'year') return { from: `${a.getFullYear()}-01-01`, to: `${a.getFullYear()}-12-31` };
  const [f, t] = [state.customFrom, state.customTo].sort();
  return { from: f, to: t };
}

function rangeTitle({ from, to }) {
  const a = state.anchor;
  if (state.mode === 'month') return `${MONTHS[a.getMonth()]} ${a.getFullYear()}`;
  if (state.mode === 'year') return `${a.getFullYear()} год`;
  return rangeLabel(from, to);
}

function shift(delta) {
  const a = new Date(state.anchor);
  if (state.mode === 'week') a.setDate(a.getDate() + 7 * delta);
  if (state.mode === 'month') { a.setDate(1); a.setMonth(a.getMonth() + delta); }
  if (state.mode === 'year') a.setFullYear(a.getFullYear() + delta);
  state.anchor = a;
  state.selectedMonth = null;
  renderStats();
}

// =====================================================================
// ЛИМИТЫ (используются и на вкладке «Траты»)
// =====================================================================
/**
 * Для каждой категории с лимитом: сколько потрачено за месяц и статус.
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

/** Предупреждение после добавления траты, если подбираемся к лимиту. */
export async function checkLimitAfterSave(tx) {
  if (tx.type !== 'expense') return false;
  const cat = await db.get('categories', tx.categoryId);
  if (!cat || !(cat.limit > 0)) return false;
  const [y, m] = tx.date.split('-').map(Number);
  const { from, to } = monthRange(y, m - 1);
  const items = await db.getTransactionsBetween(from, to);
  const st = limitStatuses([cat], items)[0];
  if (st.status === 'over') {
    toast(`⛔ Лимит «${cat.name}» превышен: ${formatMoney(st.spent)} из ${formatMoney(st.limit)}`, 4000);
    return true;
  }
  if (st.status === 'warn') {
    toast(`⚠️ «${cat.name}»: ${st.pct}% лимита, осталось ${formatMoney(st.limit - st.spent)}`, 4000);
    return true;
  }
  return false;
}

// =====================================================================
// ОТРИСОВКА
// =====================================================================
export async function renderStats() {
  for (const b of $('stats-mode').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.mode === state.mode);
  }
  const custom = state.mode === 'custom';
  $('stats-nav').hidden = custom;
  $('stats-custom').hidden = !custom;

  const range = currentRange();
  $('stats-title').textContent = rangeTitle(range);
  if (custom) {
    $('stats-from').value = state.customFrom;
    $('stats-to').value = state.customTo;
  }

  const categories = await db.getAll('categories');
  const items = await db.getTransactionsBetween(range.from, range.to);

  renderSummary(items, range);
  renderBreakdown(items, categories);
  await renderMonthly(range);
  await renderLimits(categories);
}

function renderSummary(items, { from, to }) {
  let expense = 0, income = 0;
  for (const t of items) {
    if (t.type === 'income') income += t.amount; else expense += t.amount;
  }
  const balance = income - expense;
  $('st-expense').textContent = formatMoney(expense);
  $('st-income').textContent = formatMoney(income);
  $('st-balance').textContent = (balance > 0 ? '+' : '') + formatMoney(balance);
  $('st-balance').className = balance < 0 ? 'negative' : '';

  // Средний расход в день — считаем только прошедшие дни периода
  const today = todayISO();
  const end = to < today ? to : today;
  const days = from > today ? 0 : daysBetween(from, end) + 1;
  $('st-avg').textContent = days > 0 ? formatMoney(Math.round(expense / days)) : '—';
}

function renderBreakdown(items, categories) {
  for (const b of $('st-breakdown-type').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.type === state.breakdown);
  }
  const type = state.breakdown;
  // Постоянный номер цвета для каждой категории — по порядку в списке
  const ordered = categories.filter((c) => c.type === type).sort((a, b) => a.order - b.order);
  const slotOf = new Map(ordered.map((c, i) => [c.id, i]));

  const sums = new Map();
  for (const t of items) {
    if (t.type === type) sums.set(t.categoryId, (sums.get(t.categoryId) || 0) + t.amount);
  }
  const total = [...sums.values()].reduce((s, v) => s + v, 0);
  const rows = [...sums.entries()]
    .map(([id, sum]) => ({ cat: categories.find((c) => c.id === id) || { name: 'Без категории', emoji: '❔' }, sum, slot: slotOf.has(id) ? slotOf.get(id) : SLOTS }))
    .sort((a, b) => b.sum - a.sum);

  const word = type === 'expense' ? 'расходов' : 'доходов';
  if (!total) {
    $('st-donut').innerHTML = '';
    $('st-legend').innerHTML = `<div class="empty small">За этот период ${word} нет</div>`;
    return;
  }

  // Кольцевая диаграмма из дуг (окружность с пунктирной обводкой)
  const R = 70, W = 22, C = 2 * Math.PI * R, GAP = rows.length > 1 ? 2 : 0;
  let offset = 0;
  const arcs = rows.map((r) => {
    const len = (r.sum / total) * C;
    const dash = Math.max(len - GAP, 0.01);
    const arc = `<circle cx="90" cy="90" r="${R}" fill="none" stroke-width="${W}"
      style="stroke:${colorVar(r.slot)}" stroke-dasharray="${dash} ${C - dash}"
      stroke-dashoffset="${-offset}"><title>${escapeHTML(r.cat.name)}: ${formatMoney(r.sum)}</title></circle>`;
    offset += len;
    return arc;
  }).join('');
  $('st-donut').innerHTML = `
    <svg viewBox="0 0 180 180" role="img" aria-label="Разбивка ${word} по категориям">
      <g transform="rotate(-90 90 90)">${arcs}</g>
      <text x="90" y="86" text-anchor="middle" class="donut-total">${formatMoneyShort(total)}</text>
      <text x="90" y="106" text-anchor="middle" class="donut-label">${type === 'expense' ? 'расходы' : 'доходы'}</text>
    </svg>`;

  // Легенда — она же таблица с точными суммами
  $('st-legend').innerHTML = rows.map((r) => {
    const pct = (r.sum / total) * 100;
    return `<div class="legend-row">
      <span class="dot" style="background:${colorVar(r.slot)}"></span>
      <span class="legend-name">${r.cat.emoji} ${escapeHTML(r.cat.name)}</span>
      <span class="legend-pct">${pct < 1 ? '<1' : Math.round(pct)}%</span>
      <span class="legend-sum">${formatMoney(r.sum)}</span>
    </div>`;
  }).join('');
}

/** Столбики «расходы / доходы» за 6 месяцев, заканчивая месяцем периода. */
async function renderMonthly(range) {
  const end = fromISODate(range.to);
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
    months.push({ y: d.getFullYear(), m: d.getMonth(), key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, expense: 0, income: 0 });
  }
  const from = monthRange(months[0].y, months[0].m).from;
  const to = monthRange(months[5].y, months[5].m).to;
  for (const t of await db.getTransactionsBetween(from, to)) {
    const mo = months.find((x) => x.key === t.date.slice(0, 7));
    if (mo) mo[t.type === 'income' ? 'income' : 'expense'] += t.amount;
  }

  if (!months.some((mo) => mo.key === state.selectedMonth)) state.selectedMonth = months[5].key;

  const W = 330, H = 150, TOP = 18, BOTTOM = 22, plotH = H - TOP - BOTTOM;
  const max = Math.max(1, ...months.flatMap((mo) => [mo.expense, mo.income]));
  const groupW = W / 6, barW = 14, gap = 2;
  const y = (v) => TOP + plotH - (v / max) * plotH;

  // Столбик со скруглённым верхом (4px), прижат к нижней линии
  const bar = (x, v, color) => {
    if (!v) return '';
    const top = y(v), h = TOP + plotH - top, r = Math.min(4, h, barW / 2);
    return `<path style="fill:${color}" d="M${x},${TOP + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${TOP + plotH} Z"/>`;
  };

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Расходы и доходы по месяцам">`;
  // Линия максимума с подписью и нижняя линия — едва заметные
  svg += `<line x1="0" x2="${W}" y1="${TOP}" y2="${TOP}" class="grid"/>`;
  svg += `<text x="0" y="${TOP - 5}" class="axis-label">${formatMoneyShort(max)}</text>`;
  svg += `<line x1="0" x2="${W}" y1="${TOP + plotH}" y2="${TOP + plotH}" class="baseline"/>`;
  months.forEach((mo, i) => {
    const gx = i * groupW;
    const cx = gx + groupW / 2;
    const sel = mo.key === state.selectedMonth;
    if (sel) svg += `<rect x="${gx + 4}" y="${TOP - 4}" width="${groupW - 8}" height="${plotH + 4 + BOTTOM}" rx="8" class="sel-bg"/>`;
    svg += bar(cx - barW - gap / 2, mo.expense, 'var(--series-expense)');
    svg += bar(cx + gap / 2, mo.income, 'var(--series-income)');
    svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle" class="axis-label ${sel ? 'sel' : ''}">${MONTHS_SHORT[mo.m]}</text>`;
    // Невидимая область нажатия — шире самих столбиков
    svg += `<rect x="${gx}" y="0" width="${groupW}" height="${H}" fill="transparent" data-month="${mo.key}" class="hit"/>`;
  });
  svg += '</svg>';
  $('st-monthly').innerHTML = svg;

  const s = months.find((mo) => mo.key === state.selectedMonth);
  const bal = s.income - s.expense;
  $('st-monthly-caption').innerHTML = `
    <b>${MONTHS[s.m]} ${s.y}</b>
    <div class="caption-row"><span><i class="dot" style="background:var(--series-expense)"></i>Расходы</span><b>${formatMoney(s.expense)}</b></div>
    <div class="caption-row"><span><i class="dot" style="background:var(--series-income)"></i>Доходы</span><b>${formatMoney(s.income)}</b></div>
    <div class="caption-row"><span class="muted">Баланс</span><b class="${bal < 0 ? 'negative' : ''}">${bal > 0 ? '+' : ''}${formatMoney(bal)}</b></div>`;
}

async function renderLimits(categories) {
  // Лимиты считаем за месяц: выбранный (в режиме «Месяц») или текущий
  const base = state.mode === 'month' ? state.anchor : new Date();
  const { from, to } = monthRange(base.getFullYear(), base.getMonth());
  const items = await db.getTransactionsBetween(from, to);
  const list = limitStatuses(categories, items);
  $('st-limits-title').textContent = `Лимиты · ${MONTHS[base.getMonth()].toLowerCase()}`;

  if (!list.length) {
    $('st-limits').innerHTML = `<p class="small muted" style="margin:0 0 10px">
      Задайте лимит на месяц для категории — приложение предупредит, когда траты подойдут к 80%.</p>`;
    return;
  }
  $('st-limits').innerHTML = list.map((l) => {
    const label = l.status === 'over'
      ? `<span class="status over">⛔ превышен на ${formatMoney(l.spent - l.limit)}</span>`
      : l.status === 'warn'
        ? `<span class="status warn">⚠️ ${l.pct}% — осталось ${formatMoney(l.limit - l.spent)}</span>`
        : `<span class="status ok">осталось ${formatMoney(l.limit - l.spent)}</span>`;
    return `<div class="limit-row">
      <div class="limit-head">
        <span>${l.category.emoji} ${escapeHTML(l.category.name)}</span>
        <span class="small">${formatMoney(l.spent)} <span class="muted">из ${formatMoney(l.limit)}</span></span>
      </div>
      <div class="progress big limit-bar ${l.status}"><i style="width:${Math.min(100, l.pct)}%"></i></div>
      ${label}
    </div>`;
  }).join('');
}

// =====================================================================
// ОБРАБОТЧИКИ НАЖАТИЙ
// =====================================================================
export function initStats() {
  $('stats-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.mode = b.dataset.mode;
    state.anchor = new Date();
    state.selectedMonth = null;
    renderStats();
  });
  $('stats-prev').addEventListener('click', () => shift(-1));
  $('stats-next').addEventListener('click', () => shift(1));
  $('stats-from').addEventListener('change', (e) => { state.customFrom = e.target.value || todayISO(); renderStats(); });
  $('stats-to').addEventListener('change', (e) => { state.customTo = e.target.value || todayISO(); renderStats(); });

  $('st-breakdown-type').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.breakdown = b.dataset.type;
    const range = currentRange();
    renderBreakdown(await db.getTransactionsBetween(range.from, range.to), await db.getAll('categories'));
  });

  $('st-monthly').addEventListener('click', (e) => {
    const hit = e.target.closest('[data-month]');
    if (!hit) return;
    state.selectedMonth = hit.dataset.month;
    renderMonthly(currentRange());
  });

  $('st-limits-edit').addEventListener('click', () => openCategories('expense'));
}

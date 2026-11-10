// =====================================================================
// planui.js — интерфейс плана и лимитов:
//   • вкладка «Лимит» в окне «+»
//   • карточка «План на месяц» на вкладке «Траты»
//   • итоги прошлого месяца и напоминания
// =====================================================================

import * as db from './db.js';
import {
  formatMoney, parseMoney, moneyToInput, escapeHTML, todayISO, MONTHS, MONTHS_GEN, now,
} from './utils.js';
import { $, shake, toast, actionSheet } from './ui.js';
import {
  PERIODS, getPlan, getPlanForEdit, savePlan, setLimit, removeLimit, dailyRate,
  monthAllocation, planSummary, todayState, monthResult, currentMonthKey,
  monthBounds, prevMonthKey, listTemplates, newTemplate, saveTemplate, deleteTemplate,
  applyTemplate, monthsUsing, getTemplate, limitLabel,
} from './plan.js';
import { monthCloseBlock } from './savings.js';

const BUDGET = '__budget__'; // особый «чип» — бюджет месяца

const form = {
  plan: null,          // редактируемый план текущего месяца
  categories: [],
  selected: BUDGET,    // выбранный чип: BUDGET или id категории
  period: 'day',
  uneven: false,       // включены разные суммы по дням недели
};

function monthNameGen(key) {
  return MONTHS_GEN[Number(key.slice(5, 7)) - 1];
}
function monthName(key) {
  return MONTHS[Number(key.slice(5, 7)) - 1].toLowerCase();
}

// =====================================================================
// ВКЛАДКА «ЛИМИТ» В ОКНЕ «+»
// =====================================================================
/**
 * Показать форму лимита.
 * categoryId — сразу выбрать категорию; monthKey — план какого месяца менять.
 */
export async function showLimitForm(categoryId = null, monthKey = currentMonthKey()) {
  form.plan = await getPlanForEdit(monthKey);
  form.categories = (await db.getAll('categories'))
    .filter((c) => c.type === 'expense' && !c.archived)
    .sort((a, b) => a.order - b.order);
  // Если бюджет ещё не задан — начинаем с него
  form.selected = categoryId || (form.plan.income > 0 ? (form.categories[0]?.id ?? BUDGET) : BUDGET);
  selectChip(form.selected);
}

function limitOf(categoryId) {
  return form.plan.limits.find((l) => l.categoryId === categoryId);
}

function shortLimit(l) {
  return limitLabel(l, formatMoney);
}

// ---------- Разные суммы по дням недели ----------
const wdInputs = () => [...$('wd-grid').querySelectorAll('input')];

/** Заполнить 7 полей Пн–Вс (копейки) и быстрые поля «Будни / Выходные». */
function fillWeekdays(w) {
  wdInputs().forEach((inp, i) => { inp.value = w[i] ? moneyToInput(w[i]) : '0'; });
  const same = (arr) => arr.every((x) => x === arr[0]);
  $('wd-weekday').value = same(w.slice(0, 5)) ? moneyToInput(w[0]) : '';
  $('wd-weekend').value = w[5] === w[6] ? moneyToInput(w[5]) : '';
}

/** Прочитать 7 полей. null — если в каком-то поле ошибка. */
function readWeekdays() {
  const w = wdInputs().map((inp) => {
    const t = inp.value.trim();
    return t === '' ? 0 : parseMoney(t);
  });
  return w.every((x) => x >= 0) ? w : null;
}

function setUneven(on) {
  form.uneven = on;
  $('wd-toggle').checked = on;
  if (on) {
    // Стартовые значения — из суммы в большом поле
    const amount = parseMoney($('tx-amount').value) || 0;
    const base = form.period === 'week' ? Math.round(amount / 7) : amount;
    if (!wdInputs().some((i) => parseMoney(i.value) > 0)) fillWeekdays(Array(7).fill(base));
    form.period = 'day';
  }
}

function selectChip(id) {
  form.selected = id;
  if (id === BUDGET) {
    $('tx-amount').value = form.plan.income ? moneyToInput(form.plan.income) : '';
    $('budget-savings').value = form.plan.savings ? moneyToInput(form.plan.savings) : '';
  } else {
    const l = limitOf(id);
    form.period = l ? l.period : 'day';
    $('tx-amount').value = l && !l.weekdays ? moneyToInput(l.amount) : '';
    form.uneven = !!(l && l.weekdays);
    if (form.uneven) fillWeekdays(l.weekdays);
    else wdInputs().forEach((i) => { i.value = ''; });
  }
  renderLimitForm();
}

/** Строка «План: Мой план ▾» над суммой. */
function renderPlanPicker() {
  const p = form.plan;
  const name = escapeHTML(p.name || 'Мой план');
  $('plan-picker').innerHTML = p.mode === 'snapshot'
    ? `<span class="muted">План «${name}» · ${monthName(p.month)} прошёл — меняется только он</span>`
    : `<button type="button" class="picker-btn" id="plan-picker-btn">План: <b>${name}</b> ▾</button>
       <span class="muted small">${p.isNew ? 'новый шаблон' : 'изменения — для этого и следующих месяцев'}</span>`;
}

/** Меню выбора шаблона для месяца формы. */
async function openPlanPicker() {
  const key = form.plan.month;
  const templates = await listTemplates();
  const items = templates.map((t) => ({
    label: t.name,
    sub: planSub(t),
    checked: t.id === form.plan.templateId,
    async onClick() {
      await applyTemplate(key, t.id);
      toast(`На ${monthName(key)}: план «${t.name}»`);
      document.dispatchEvent(new Event('plan-changed'));
      await reloadForm();
    },
  }));
  items.push({
    label: '＋ Новый пустой план',
    async onClick() {
      const name = askName('Название нового плана', 'Новый план');
      if (!name) return;
      const t = newTemplate(name);
      await saveTemplate(t);
      await applyTemplate(key, t.id);
      document.dispatchEvent(new Event('plan-changed'));
      await reloadForm(BUDGET);
    },
  });
  if (!form.plan.isNew) {
    items.push({
      label: `⧉ Копия «${form.plan.name}»`,
      async onClick() {
        const name = askName('Название копии', `${form.plan.name} (копия)`);
        if (!name) return;
        const t = newTemplate(name, form.plan);
        await saveTemplate(t);
        await applyTemplate(key, t.id);
        document.dispatchEvent(new Event('plan-changed'));
        await reloadForm();
      },
    });
  }
  actionSheet(`План на ${monthName(key)}`, items);
}

async function reloadForm(select = null) {
  const keep = select || form.selected;
  form.plan = await getPlanForEdit(form.plan.month);
  selectChip(keep);
}

function askName(question, value) {
  const name = (prompt(question, value) || '').trim();
  return name.slice(0, 40);
}

/** Краткое описание шаблона: «20 000 ₽ · 3 лимита». */
function planSub(t) {
  const parts = [];
  if (t.income) parts.push(`бюджет ${formatMoney(t.income)}`);
  parts.push(t.limits.length ? `лимитов: ${t.limits.length}` : 'без лимитов');
  return parts.join(' · ');
}

function renderLimitForm() {
  renderPlanPicker();
  const isBudget = form.selected === BUDGET;
  $('amount-caption').textContent = isBudget
    ? `Бюджет на ${monthName(form.plan.month)}`
    : 'Сумма лимита';

  // Чипы: бюджет + категории расходов (с подписью текущего лимита)
  const budgetSub = form.plan.income ? formatMoney(form.plan.income) : 'не задан';
  $('limit-categories').innerHTML = `
    <button type="button" class="cat-chip ${isBudget ? 'active' : ''}" data-id="${BUDGET}">
      <span class="e">💰</span><span class="n">Бюджет</span><span class="sub">${budgetSub}</span>
    </button>` + form.categories.map((c) => {
    const l = limitOf(c.id);
    return `<button type="button" class="cat-chip ${c.id === form.selected ? 'active' : ''}" data-id="${c.id}">
      <span class="e">${c.emoji}</span><span class="n">${escapeHTML(c.name)}</span>
      <span class="sub">${l ? shortLimit(l) : '—'}</span>
    </button>`;
  }).join('');

  $('limit-period').hidden = isBudget;
  $('budget-fields').hidden = !isBudget;
  // Разные суммы по дням — только для лимита в день / неделю
  $('wd-toggle-row').hidden = isBudget || form.period === 'month';
  if (isBudget || form.period === 'month') form.uneven = false;
  $('wd-toggle').checked = form.uneven;
  $('wd-fields').hidden = !form.uneven;
  $('amount-wrap').hidden = form.uneven;
  if (form.uneven) $('amount-caption').textContent = 'Лимит по дням недели';
  for (const b of $('limit-period').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.period === form.period);
  }
  $('limit-delete').hidden = isBudget || !limitOf(form.selected);
  renderLimitInfo();
}

/** Подсказка с пересчётом: сколько это в день / неделю / месяц и что останется. */
function renderLimitInfo() {
  const amount = parseMoney($('tx-amount').value) || 0;
  const plan = structuredClone(form.plan);
  const key = plan.month;
  let lines = [];

  if (form.selected === BUDGET) {
    plan.income = amount;
    plan.savings = parseMoney($('budget-savings').value) || 0;
  } else if (form.uneven) {
    const w = readWeekdays();
    if (w && w.some((x) => x > 0)) {
      setLimit(plan, form.selected, 'day', 0, w);
      const l = plan.limits.find((x) => x.categoryId === form.selected);
      lines.push(`= <b>${formatMoney(w.reduce((a, b) => a + b, 0))} в неделю</b>`);
      lines.push(`≈ ${formatMoney(monthAllocation(l, key))} за ${monthName(key)}`);
      lines.push('Экономия переходит на следующий день, перерасход — вычитается.');
    }
  } else if (amount > 0) {
    setLimit(plan, form.selected, form.period, amount);
    const l = plan.limits.find((x) => x.categoryId === form.selected);
    const rate = dailyRate(l);
    if (form.period === 'day') lines.push(`= ${formatMoney(Math.round(rate * 7))} в неделю`);
    if (form.period === 'week') lines.push(`= <b>${formatMoney(Math.round(rate))} в день</b>`);
    if (form.period === 'month') {
      const { to, from } = monthBounds(key);
      const days = Number(to.slice(8)) - Number(from.slice(8)) + 1;
      lines.push(`≈ ${formatMoney(Math.round(amount / days / 100) * 100)} в день (без переноса по дням)`);
    } else {
      lines.push(`≈ ${formatMoney(monthAllocation(l, key))} за ${monthName(key)}`);
      lines.push('Экономия переходит на следующий день, перерасход — вычитается.');
    }
  }

  if (plan.income > 0) {
    const s = planSummary(plan, form.categories);
    lines.push(`<span class="plan-line">На траты: ${formatMoney(s.available)} · по лимитам: ${formatMoney(s.allocated)}</span>`);
    lines.push(s.free >= 0
      ? `<span class="plan-line">Свободно: <b class="income">${formatMoney(s.free)}</b></span>`
      : `<span class="plan-line negative">Не хватает ${formatMoney(-s.free)} — лимиты больше бюджета</span>`);
  } else if (form.selected !== BUDGET) {
    lines.push('<span class="muted">Задайте 💰 Бюджет, чтобы видеть, сколько остаётся свободным.</span>');
  }
  $('limit-info').innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
}

/** Кнопка «Готово» в режиме лимита. true — сохранено. */
export async function saveLimitForm() {
  const amount = parseMoney($('tx-amount').value);
  if (form.selected === BUDGET) {
    if (!(amount > 0)) { shake($('tx-amount')); return false; }
    const savingsText = $('budget-savings').value.trim();
    const savings = savingsText ? parseMoney(savingsText) : 0;
    if (!(savings >= 0) || savings > amount) { shake($('budget-savings')); toast('Копилка больше бюджета'); return false; }
    form.plan.income = amount;
    form.plan.savings = savings;
    await savePlan(form.plan);
    toast(`План на ${monthName(form.plan.month)}: на траты ${formatMoney(amount - savings)}`);
    return true;
  }
  const cat = form.categories.find((c) => c.id === form.selected);
  if (form.uneven) {
    const w = readWeekdays();
    if (!w || !w.some((x) => x > 0)) { shake($('wd-grid')); toast('Проверьте суммы по дням'); return false; }
    setLimit(form.plan, form.selected, 'day', 0, w);
  } else {
    if (!(amount > 0)) { shake($('tx-amount')); return false; }
    setLimit(form.plan, form.selected, form.period, amount);
  }
  await savePlan(form.plan);
  toast(`Лимит «${cat.name}»: ${shortLimit(limitOf(form.selected))}`);
  return true;
}

async function deleteLimit() {
  const cat = form.categories.find((c) => c.id === form.selected);
  if (!confirm(`Убрать лимит для «${cat.name}»?`)) return;
  removeLimit(form.plan, form.selected);
  await savePlan(form.plan);
  toast('Лимит убран');
  document.dispatchEvent(new Event('plan-changed'));
  selectChip(form.selected);
}

export function initLimitForm() {
  $('limit-categories').addEventListener('click', (e) => {
    const b = e.target.closest('.cat-chip');
    if (b) selectChip(b.dataset.id);
  });
  $('limit-period').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    form.period = b.dataset.period;
    renderLimitForm();
  });
  $('wd-toggle').addEventListener('change', (e) => { setUneven(e.target.checked); renderLimitForm(); });
  // «Будни» / «Выходные» — заполняют сразу несколько дней
  $('wd-weekday').addEventListener('input', (e) => {
    wdInputs().slice(0, 5).forEach((i) => { i.value = e.target.value; });
    renderLimitInfo();
  });
  $('wd-weekend').addEventListener('input', (e) => {
    wdInputs().slice(5).forEach((i) => { i.value = e.target.value; });
    renderLimitInfo();
  });
  $('wd-grid').addEventListener('input', () => {
    const w = readWeekdays();
    if (w) {
      const same = (arr) => arr.every((x) => x === arr[0]);
      $('wd-weekday').value = same(w.slice(0, 5)) ? moneyToInput(w[0]) : '';
      $('wd-weekend').value = w[5] === w[6] ? moneyToInput(w[5]) : '';
    }
    renderLimitInfo();
  });
  $('tx-amount').addEventListener('input', () => { if (form.plan && !$('limit-fields').hidden) renderLimitInfo(); });
  $('budget-savings').addEventListener('input', renderLimitInfo);
  $('limit-delete').addEventListener('click', deleteLimit);
  $('plan-picker').addEventListener('click', (e) => {
    if (e.target.closest('#plan-picker-btn')) openPlanPicker();
  });
}

// =====================================================================
// НАСТРОЙКИ → «ПЛАНЫ»: список шаблонов
// =====================================================================
export async function renderTemplatesSettings() {
  const box = $('tpl-list');
  const templates = await listTemplates();
  const cur = currentMonthKey();
  const curPlan = await getPlan(cur);

  if (!templates.length) {
    box.innerHTML = `<p class="small muted" style="margin:0">Планов пока нет. Составьте первый: «+» → «Лимит».</p>`;
    return;
  }
  box.innerHTML = templates.map((t) => `
    <button type="button" class="tpl-row" data-tpl="${t.id}">
      <span class="tpl-main">
        <b>${escapeHTML(t.name)}</b>
        <small class="muted">${planSub(t)}</small>
      </span>
      ${curPlan && curPlan.templateId === t.id ? `<span class="badge">в ${monthName(cur).slice(0, 3)}.</span>` : ''}
      <span class="muted">⋯</span>
    </button>`).join('');
}

async function templateActions(id) {
  const t = await getTemplate(id);
  const cur = currentMonthKey();
  actionSheet(`«${t.name}»`, [
    {
      label: `Выбрать на ${monthName(cur)}`,
      async onClick() {
        await applyTemplate(cur, t.id);
        toast(`На ${monthName(cur)}: план «${t.name}»`);
        document.dispatchEvent(new Event('plan-changed'));
      },
    },
    {
      label: 'Переименовать',
      async onClick() {
        const name = askName('Новое название', t.name);
        if (!name) return;
        t.name = name;
        await saveTemplate(t);
        document.dispatchEvent(new Event('plan-changed'));
      },
    },
    {
      label: 'Сделать копию',
      async onClick() {
        const name = askName('Название копии', `${t.name} (копия)`);
        if (!name) return;
        await saveTemplate(newTemplate(name, t));
        document.dispatchEvent(new Event('plan-changed'));
      },
    },
    {
      label: 'Удалить',
      danger: true,
      async onClick() {
        const used = await monthsUsing(t.id);
        if (used.length) {
          toast(`План выбран на ${used.map(monthName).join(', ')} — сначала выберите другой`, 4000);
          return;
        }
        if (!confirm(`Удалить план «${t.name}»? Итоги прошлых месяцев сохранятся.`)) return;
        await deleteTemplate(t.id);
        document.dispatchEvent(new Event('plan-changed'));
      },
    },
  ]);
}

export function initTemplatesSettings() {
  $('tpl-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tpl]');
    if (b) templateActions(b.dataset.tpl);
  });
  $('tpl-new').addEventListener('click', async () => {
    const name = askName('Название нового плана', 'Новый план');
    if (!name) return;
    await saveTemplate(newTemplate(name));
    document.dispatchEvent(new Event('plan-changed'));
    toast(`План «${name}» создан — выберите его и задайте лимиты`, 3500);
  });
}

// =====================================================================
// КАРТОЧКА «ПЛАН НА МЕСЯЦ» НА ВКЛАДКЕ «ТРАТЫ»
// =====================================================================
/**
 * Главный экран:
 *   • #today-hero — крупно «Сегодня можно» по дневным лимитам
 *   • #plan-card  — подробности плана (в свёрнутой секции)
 * Возвращает id категорий с дневным лимитом (их ставим первыми в «+»).
 */
export async function renderPlanCard(viewKey, monthItems) {
  const key = currentMonthKey();
  const card = $('plan-card');
  const hero = $('today-hero');
  if (viewKey !== key) {
    hero.innerHTML = ''; $('month-report').innerHTML = '';
    await renderPlanOverview(viewKey);
    return [];
  }

  await renderMonthReport(key);

  const categories = await db.getAll('categories');
  const plan = await getPlan(key);
  if (!plan || (!plan.income && !plan.limits.length)) {
    hero.innerHTML = `<button type="button" class="card hero hero-empty" data-plan-edit="${BUDGET}">
      <span class="hero-label">Сколько можно тратить в день?</span>
      <span class="hero-cta">Составить план →</span>
    </button>`;
    card.innerHTML = '';
    return [];
  }

  const st = todayState(plan, categories, monthItems);
  const sum = planSummary(plan, categories);
  const daily = st.rows.filter((r) => r.kind === 'daily');
  const monthly = st.rows.filter((r) => r.kind === 'month');

  // ---------- Крупная карточка «Сегодня можно» ----------
  const carryText = (r) => r.carry === 0 ? ''
    : r.carry > 0 ? ` <span class="income">+${formatMoney(r.carry)} экономия</span>`
      : ` <span class="negative">−${formatMoney(-r.carry)} перерасход</span>`;
  const statusOf = (r) => r.remaining < 0 ? 'over'
    : r.todayLimit > 0 && r.spent / r.todayLimit >= 0.8 ? 'warn' : 'ok';
  const pctOf = (r) => r.todayLimit > 0 ? Math.min(100, Math.round((r.spent / r.todayLimit) * 100)) : 100;

  if (daily.length) {
    const [main, ...rest] = daily;
    const st0 = statusOf(main);
    hero.innerHTML = `<section class="card hero">
      <button type="button" class="hero-main" data-quick-add="${main.category.id}">
        <span class="hero-label">${main.remaining < 0 ? 'Перерасход сегодня' : 'Сегодня можно'}</span>
        <span class="hero-amount ${st0}">${formatMoney(Math.abs(main.remaining))}</span>
        <span class="progress big limit-bar ${st0}"><i style="width:${pctOf(main)}%"></i></span>
        <span class="hero-sub">${main.category.emoji} ${escapeHTML(main.category.name)} · ${formatMoney(main.base)} ${main.limit.weekdays ? 'на сегодня' : 'в день'}${carryText(main)}${main.remaining < 0 ? ' · <span class="negative">вычтется завтра</span>' : ''}</span>
      </button>
      ${rest.map((r) => `<button type="button" class="hero-row" data-quick-add="${r.category.id}">
        <span>${r.category.emoji} ${escapeHTML(r.category.name)}</span>
        <b class="today-val ${statusOf(r)}">${r.remaining < 0 ? `−${formatMoney(-r.remaining)}` : formatMoney(r.remaining)}</b>
      </button>`).join('')}
    </section>`;
  } else if (st.other) {
    const o = st.other;
    hero.innerHTML = `<section class="card hero">
      <button type="button" class="hero-main" data-quick-add="">
        <span class="hero-label">Свободно до конца месяца</span>
        <span class="hero-amount ${o.remaining < 0 ? 'over' : 'ok'}">${o.remaining < 0 ? '−' : ''}${formatMoney(Math.abs(o.remaining))}</span>
      </button>
    </section>`;
  } else {
    hero.innerHTML = '';
  }

  // ---------- Подробности плана (свёрнутая секция) ----------
  const head = plan.income > 0
    ? `<div class="plan-formula">${formatMoney(plan.income)}${plan.savings ? ` − ${formatMoney(plan.savings)} в копилку` : ''}${sum.allocated ? ` − ${formatMoney(sum.allocated)} лимиты` : ''} = <b class="${sum.free < 0 ? 'negative' : ''}">${formatMoney(sum.free)} свободно</b></div>`
    : '';

  const dailyRows = daily.map((r) => `<button type="button" class="plan-row" data-plan-edit="${r.category.id}">
      <div class="plan-row-head">
        <span class="today-name">${r.category.emoji} ${escapeHTML(r.category.name)}</span>
        <span class="today-val">${shortLimit(r.limit)}</span>
      </div>
      <div class="plan-row-sub"><span>сегодня ${formatMoney(Math.max(0, r.todayLimit))} = ${formatMoney(r.base)}${carryText(r)}</span></div>
    </button>`).join('');

  const monthRow = (name, emoji, spent, total, remaining, editId) => {
    const pct = total > 0 ? Math.min(100, Math.round((spent / total) * 100)) : 100;
    const status = remaining < 0 ? 'over' : pct >= 80 ? 'warn' : 'ok';
    return `<button type="button" class="plan-row" ${editId ? `data-plan-edit="${editId}"` : ''}>
      <div class="plan-row-head">
        <span class="today-name">${emoji} ${escapeHTML(name)}</span>
        <span class="today-val ${status}">${remaining < 0 ? `превышен на ${formatMoney(-remaining)}` : `осталось ${formatMoney(remaining)}`}</span>
      </div>
      <div class="progress limit-bar ${status}"><i style="width:${pct}%"></i></div>
      <div class="plan-row-sub"><span>${formatMoney(spent)} из ${formatMoney(total)} за месяц</span></div>
    </button>`;
  };
  const monthlyRows = monthly.map((r) => monthRow(r.category.name, r.category.emoji, r.spent, r.total, r.remaining, r.category.id)).join('')
    + (st.other ? monthRow('Остальные траты', '🧺', st.other.spent, st.other.total, st.other.remaining, BUDGET) : '');

  card.innerHTML = `<section class="card plan-card">
    <div class="card-head">
      <h3>План на ${monthName(key)} <small class="muted">· ${escapeHTML(plan.name || '')}</small></h3>
      <button type="button" class="link-btn small-link" data-plan-edit="${BUDGET}">Изменить</button>
    </div>
    ${head}
    ${dailyRows ? `<div class="section-title">Лимиты в день и неделю</div>${dailyRows}` : ''}
    ${monthlyRows ? `<div class="section-title">На месяц</div>${monthlyRows}` : ''}
  </section>`;

  remindOncePerDay(daily);
  return daily.map((r) => r.category.id);
}

/**
 * План другого (не текущего) месяца: бюджет, лимиты и кнопка «Изменить».
 * Так можно заранее составить план на следующий месяц или поправить прошлый.
 */
async function renderPlanOverview(key) {
  const card = $('plan-card');
  const categories = await db.getAll('categories');
  const plan = await getPlan(key);
  const edit = `data-plan-edit="${BUDGET}" data-plan-month="${key}"`;
  const mName = monthName(key);

  if (!plan || (!plan.income && !plan.limits.length)) {
    card.innerHTML = `<section class="card plan-card empty-plan">
      <div><b>Плана на ${mName} нет</b>
      <p class="small muted">Можно составить заранее: бюджет, копилка и лимиты.</p></div>
      <button type="button" class="primary-btn full" ${edit}>Составить план на ${mName}</button>
    </section>`;
    return;
  }

  const sum = planSummary(plan, categories);
  const rows = plan.limits.map((l) => {
    const c = categories.find((x) => x.id === l.categoryId);
    if (!c || c.archived) return '';
    return `<button type="button" class="plan-row" data-plan-edit="${c.id}" data-plan-month="${key}">
      <div class="plan-row-head">
        <span class="today-name">${c.emoji} ${escapeHTML(c.name)}</span>
        <span class="today-val">${shortLimit(l)}</span>
      </div>
      <div class="plan-row-sub"><span>≈ ${formatMoney(monthAllocation(l, key))} за месяц</span></div>
    </button>`;
  }).join('');

  card.innerHTML = `<section class="card plan-card">
    <div class="card-head">
      <h3>План на ${mName} <small class="muted">· ${escapeHTML(plan.name || '')}</small></h3>
      <button type="button" class="link-btn small-link" ${edit}>Изменить</button>
    </div>
    ${plan.inherited && !plan.past ? '<p class="small muted" style="margin:0 0 6px">Тот же план, что и в прошлом месяце. Другой можно выбрать в «Изменить» → «План ▾».</p>' : ''}
    ${plan.income > 0 ? `<div class="plan-formula">${formatMoney(plan.income)}${plan.savings ? ` − ${formatMoney(plan.savings)} в копилку` : ''}${sum.allocated ? ` − ${formatMoney(sum.allocated)} лимиты` : ''} = <b class="${sum.free < 0 ? 'negative' : ''}">${formatMoney(sum.free)} свободно</b></div>` : ''}
    ${rows ? `<div class="section-title">Лимиты</div>${rows}` : ''}
  </section>`;
}

/** Раз в день — напоминание, сколько можно потратить сегодня с учётом переноса. */
function remindOncePerDay(daily) {
  if (!daily.length) return;
  let shown = null;
  try { shown = localStorage.getItem('planReminder'); } catch { /* ничего */ }
  if (shown === todayISO()) return;
  try { localStorage.setItem('planReminder', todayISO()); } catch { /* ничего */ }
  const r = daily[0];
  let msg = `Сегодня на «${r.category.name}» — ${formatMoney(Math.max(0, r.todayLimit))}`;
  if (r.carry > 0) msg += ` (+${formatMoney(r.carry)} экономии) 👏`;
  if (r.carry < 0) msg += ` (−${formatMoney(-r.carry)} за перерасход)`;
  setTimeout(() => toast(msg, 4500), 600);
}

/** Итоги прошлого месяца — показываем в начале нового, пока не закроют. */
async function renderMonthReport(key) {
  const box = $('month-report');
  const prev = prevMonthKey(key);
  let dismissed = null;
  try { dismissed = localStorage.getItem('monthReportClosed'); } catch { /* ничего */ }
  const plan = await getPlan(prev);
  if (!plan || dismissed === prev) { box.innerHTML = ''; return; }

  const { from, to } = monthBounds(prev);
  const categories = await db.getAll('categories');
  const res = monthResult(plan, categories, await db.getTransactionsBetween(from, to), to);
  if (!res.rows.length && !res.other) { box.innerHTML = ''; return; }

  box.innerHTML = `<section class="card month-report">
    <div class="card-head">
      <h3>Итоги ${monthNameGen(prev)} 🏁</h3>
      <button type="button" class="pay-del" id="month-report-close" aria-label="Закрыть">✕</button>
    </div>
    <div class="daily-totals">
      <div><span class="muted">Сэкономлено</span><b class="income">+${formatMoney(res.saved)}</b></div>
      <div><span class="muted">Превышение</span><b class="negative">−${formatMoney(res.over)}</b></div>
      <div><span class="muted">По плану</span><b>${formatMoney(plan.savings)}</b></div>
    </div>
    ${await monthCloseBlock(prev)}
    <p class="small muted" style="margin:8px 0 0">Подробности — в «Статистике» за ${monthName(prev)}. Новый месяц начат с чистого листа.</p>
  </section>`;
  $('month-report-close').addEventListener('click', () => {
    try { localStorage.setItem('monthReportClosed', prev); } catch { /* ничего */ }
    box.innerHTML = '';
  });
}

// =====================================================================
// СООБЩЕНИЕ ПОСЛЕ ДОБАВЛЕНИЯ ТРАТЫ
// =====================================================================
/** true — показали сообщение про лимит. action — кнопка «Отменить». */
export async function planToastAfterSave(tx, action = null) {
  if (tx.type !== 'expense' || tx.date.slice(0, 7) !== currentMonthKey()) return false;
  const plan = await getPlan(currentMonthKey());
  if (!plan) return false;
  const categories = await db.getAll('categories');
  const { from, to } = monthBounds(plan.month);
  const st = todayState(plan, categories, await db.getTransactionsBetween(from, to));
  const row = st.rows.find((r) => r.category.id === tx.categoryId);

  if (row && row.kind === 'daily' && tx.date === todayISO()) {
    if (row.remaining < 0) toast(`⛔ «${row.category.name}»: превышен на ${formatMoney(-row.remaining)} — вычтется из завтрашнего лимита`, 4500, action);
    else toast(`«${row.category.name}»: на сегодня осталось ${formatMoney(row.remaining)}`, 3000, action);
    return true;
  }
  if (row && row.kind === 'month') {
    if (row.remaining < 0) toast(`⛔ «${row.category.name}»: месячный лимит превышен на ${formatMoney(-row.remaining)}`, 4500, action);
    else toast(`«${row.category.name}»: на месяц осталось ${formatMoney(row.remaining)}`, 3000, action);
    return true;
  }
  if (!row && st.other) {
    if (st.other.remaining < 0) toast(`⛔ Свободные деньги закончились: −${formatMoney(-st.other.remaining)}`, 4500, action);
    else toast(`Свободных денег на месяц: ${formatMoney(st.other.remaining)}`, 3000, action);
    return true;
  }
  return false;
}

export { BUDGET };

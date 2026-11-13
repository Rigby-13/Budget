// =====================================================================
// budgetui.js — вкладка «План» (конверты) и всё, что из неё видно
// на других экранах: «Сегодня можно», строка плана, сообщение после траты.
// =====================================================================

import * as db from './db.js';
import {
  formatMoney, parseMoney, moneyToInput, todayISO, escapeHTML, plural, shortDate,
} from './utils.js';
import {
  $, openSheet, closeSheet, closeSheets, shake, toast, actionSheet, focusField,
} from './ui.js';
import {
  computeBudget, withDailySpending, todayRows, currentMonthKey, shiftMonthKey, monthName,
  monthPrep, targetLabel, isDaily, getAssigned, setAssigned, setAssignedMany, autoAssign,
  targetsShortfall, daysLeft, getMeta, saveMeta, groupOf, monthBounds,
} from './budget.js';
import { openWalletSheet } from './wallet.js';

const ui = { key: null, cat: null, budget: null, move: null };
const fmt = formatMoney;
const signed = (v) => (v < 0 ? '−' : '') + fmt(Math.abs(v));
const changed = () => document.dispatchEvent(new Event('budget-changed'));

// =====================================================================
// ВКЛАДКА «ПЛАН»
// =====================================================================
export async function renderPlanView() {
  if (!ui.key) ui.key = currentMonthKey();
  const key = ui.key;
  const cur = currentMonthKey();
  const b = await withDailySpending(await computeBudget(key));
  ui.budget = b;
  const today = key === cur ? todayRows(b) : [];

  const [y] = key.split('-');
  $('bud-title').textContent = `План · ${monthName(key)}${y !== cur.slice(0, 4) ? ' ' + y : ''}`;
  const left = daysLeft(key);
  $('bud-sub').textContent = key === cur ? `осталось ${left} ${plural(left, 'день', 'дня', 'дней')}`
    : key < cur ? 'прошедший месяц' : 'будущий месяц — можно распределить заранее';
  $('bud-today-bar').hidden = key === cur;

  $('bud-top').innerHTML = topCard(b, key, cur);
  $('bud-over').innerHTML = b.overspent.map((r) => `<div class="bud-over">
      <span>${r.cat.emoji} ${escapeHTML(r.cat.name)} в минусе на ${fmt(-r.available)}</span>
      <button type="button" data-cover="${r.cat.id}">Покрыть</button>
    </div>`).join('');

  const head = `<div class="bud-cols"><span>НАЗНАЧЕНО</span><span>ОСТАЛОСЬ</span></div>`;
  $('bud-groups').innerHTML = head + b.groups.map((g) => `
    <button type="button" class="bud-ghead" data-group="${g.id}">
      <span>${escapeHTML(g.name.toUpperCase())}</span><span>${fmt(g.assigned)}</span>
    </button>
    <div class="bud-list">${g.rows.length ? g.rows.map((r) => rowHtml(r, key, today)).join('')
      : '<div class="bud-empty small muted">Пусто. Откройте категорию и выберите эту группу.</div>'}</div>`).join('');
}

function topCard(b, key, cur) {
  if (b.money === null) {
    return `<section class="card rta-card">
      <span class="hero-label">Готово к распределению</span>
      <p class="rta-text">Чтобы распределять деньги, укажите, сколько их у вас сейчас (все карты и наличные).</p>
      <button type="button" class="rta-btn" data-bud="wallet">Указать «Мои деньги»</button>
    </section>`;
  }
  if (key < cur) {
    return `<section class="card rta-card past">
      <span class="hero-label">Итоги: ${monthName(key).toLowerCase()}</span>
      <div class="rta-past"><div><small>Назначено</small><b>${fmt(b.assignedTotal)}</b></div>
      <div><small>Потрачено</small><b>${fmt(b.spentTotal)}</b></div></div>
      <span class="rta-sub">Сейчас готово к распределению: ${signed(b.rta)}</span>
    </section>`;
  }
  const rta = b.rta;
  const reserved = b.money - rta;
  const label = rta < 0 ? 'Распределено больше, чем есть' : 'Готово к распределению';
  return `<section class="card rta-card ${rta < 0 ? 'neg' : rta === 0 ? 'done' : ''}">
    <span class="hero-label">${label}</span>
    <span class="rta-amount">${signed(rta)}</span>
    <span class="rta-sub">${rta === 0 ? 'Каждый рубль при деле 👏' : rta < 0 ? 'Уменьшите суммы в категориях' : `Мои деньги ${fmt(b.money)} − распределено ${fmt(reserved)}`}</span>
    <button type="button" class="rta-btn" data-bud="assign">Распределить</button>
  </section>`;
}

function rowHtml(r, key, today) {
  const t = r.target;
  const td = today.find((x) => x.row === r);
  let sub = '';
  let subCls = '';
  if (r.status === 'bad') { sub = 'перерасход — нажмите «Покрыть»'; subCls = 'bad'; }
  else if (t && t.type === 'goal') {
    const pct = t.amount > 0 ? Math.min(100, Math.round((Math.max(0, r.available) / t.amount) * 100)) : 0;
    sub = r.status === 'warn'
      ? `${targetLabel(t, fmt)} · в ${monthPrep(key)} не хватает ${fmt(r.need - r.assigned)}`
      : `${targetLabel(t, fmt)} · ${pct >= 100 ? 'накоплено ✓' : pct + '%'}`;
    if (r.status === 'warn') subCls = 'warn';
  } else if (r.status === 'warn') {
    sub = `${targetLabel(t, fmt)} · не хватает ${fmt(r.need - r.assigned - r.carry)}`; subCls = 'warn';
  } else if (td) {
    sub = td.remaining < 0 ? `сегодня перерасход ${fmt(-td.remaining)}` : `сегодня можно ${fmt(td.remaining)}`;
  } else if (r.recurring.length && key >= currentMonthKey()) {
    const next = r.recurring.find((x) => x.date >= todayISO());
    sub = next ? `🔁 спишется ${shortDate(next.date)}` : '🔁 в этом месяце оплачено';
  } else if (t) sub = targetLabel(t, fmt);
  else if (r.spent) sub = `потрачено ${fmt(r.spent)}`;
  else if (!r.assigned && !r.carry) sub = 'нажмите, чтобы назначить';

  let bar = null;
  if (t && t.type === 'goal') bar = t.amount > 0 ? Math.max(0, r.available) / t.amount : 0;
  else if (r.carry + r.assigned > 0) bar = r.spent / (r.carry + r.assigned);
  const barHtml = bar === null ? '' : `<span class="bud-bar ${r.status}"><i style="width:${Math.min(100, Math.round(bar * 100))}%"></i></span>`;

  return `<button type="button" class="bud-row" data-cat="${r.cat.id}">
    <span class="tx-emoji">${r.cat.emoji}</span>
    <span class="bud-main">
      <span class="bud-name">${escapeHTML(r.cat.name)}</span>
      ${barHtml}
      ${sub ? `<span class="bud-sub ${subCls}">${sub}</span>` : ''}
    </span>
    <span class="bud-asg">${r.assigned ? fmt(r.assigned).replace(/\s*₽/, '') : '—'}</span>
    <span class="bud-pill ${r.status}">${signed(r.available)}</span>
  </button>`;
}

/** Открыть вкладку «План» на нужном месяце. */
export function setPlanMonth(key) { ui.key = key; }

// =====================================================================
// «РАСПРЕДЕЛИТЬ»
// =====================================================================
async function openAssignMenu() {
  const key = ui.key;
  const b = ui.budget;
  const short = targetsShortfall(b);
  const prev = shiftMonthKey(key, -1);
  const run = async (mode, msg) => {
    const before = await autoAssign(key, mode);
    changed();
    toast(msg, 4500, {
      label: 'Отменить',
      async onClick() { await setAssignedMany(key, before); changed(); toast('Отменено'); },
    });
  };
  const items = [];
  if (b.rows.some((r) => r.target)) {
    items.push({
      label: '🎯 По целям',
      sub: short ? `добавит ${fmt(short)} туда, где не хватает` : 'по целям уже всё назначено',
      onClick: () => run('targets', 'Назначено по целям'),
    });
  }
  items.push(
    { label: `↩ Как в ${monthPrep(prev)}`, sub: 'те же суммы, что назначали в прошлом месяце', onClick: () => run('last-assigned', 'Назначено как в прошлом месяце') },
    { label: `🧾 Сколько потратил в ${monthPrep(prev)}`, sub: 'по фактическим тратам прошлого месяца', onClick: () => run('last-spent', 'Назначено по тратам прошлого месяца') },
    { label: '🧹 Обнулить назначенное', sub: `в ${monthPrep(key)}`, danger: true, onClick: () => run('reset', 'Назначенное обнулено') },
  );
  actionSheet('Распределить деньги', items);
}

// =====================================================================
// ОКНО КАТЕГОРИИ
// =====================================================================
const TTYPES = ['none', 'day', 'week', 'month', 'goal'];
let tType = 'none';

export async function openCatSheet(catId) {
  if (!ui.key) ui.key = currentMonthKey();
  const b = ui.budget && ui.budget.key === ui.key ? ui.budget : await computeBudget(ui.key);
  const r = b.rows.find((x) => x.cat.id === catId);
  if (!r) return;
  ui.budget = b;
  ui.cat = r;
  $('bc-title').textContent = `${r.cat.emoji} ${r.cat.name}`;
  $('bc-caption').textContent = `Назначено на ${monthName(ui.key).toLowerCase()}`;
  $('bc-amount').value = r.assigned ? moneyToInput(r.assigned) : '';

  // Быстрые суммы
  const prevB = await computeBudget(shiftMonthKey(ui.key, -1));
  const pr = prevB.rows.find((x) => x.cat.id === catId);
  const quick = [];
  const needNow = r.target && r.target.type !== 'goal' ? r.need - r.carry : r.need;
  if (r.target && needNow > 0) quick.push(['По цели', needNow]);
  if (pr && pr.assigned) quick.push(['Как в прошлом', pr.assigned]);
  if (pr && pr.spent) quick.push(['Потратил', pr.spent]);
  if (r.available < 0) quick.push(['Закрыть минус', r.assigned - r.available]);
  $('bc-quick').innerHTML = quick.map(([l, v]) => `<button type="button" data-v="${v}"><small>${l}</small><b>${fmt(v)}</b></button>`).join('');
  $('bc-quick').hidden = !quick.length;

  // Цель
  const t = r.target;
  tType = t ? t.type : 'none';
  $('bc-tamount').value = t ? moneyToInput(t.type === 'day' && t.weekdays ? t.weekdays[0] : t.amount) : '';
  $('bc-wd').checked = !!(t && t.weekdays);
  $('bc-weekend').value = t && t.weekdays ? moneyToInput(t.weekdays[5]) : '';
  $('bc-tdate').value = t && t.date ? t.date : '';
  renderTarget();

  // Группы
  ui.group = r.group;
  renderGroupChips();
  renderCatInfo();
  openSheet($('bud-cat-sheet'));
}

function renderGroupChips() {
  const groups = ui.budget.meta.groups;
  $('bc-groups').innerHTML = groups.map((g) => `<button type="button" data-g="${g.id}" class="${g.id === ui.group ? 'active' : ''}">${escapeHTML(g.name)}</button>`).join('');
}

function renderTarget() {
  for (const bt of $('bc-ttype').querySelectorAll('button')) bt.classList.toggle('active', bt.dataset.t === tType);
  $('bc-tfields').hidden = tType === 'none';
  $('bc-wd-row').hidden = tType !== 'day';
  const uneven = tType === 'day' && $('bc-wd').checked;
  $('bc-weekend-field').hidden = !uneven;
  $('bc-tdate-field').hidden = tType !== 'goal';
  $('bc-tlabel').textContent = {
    day: uneven ? 'В будни (пн–пт), ₽' : 'Сколько в день, ₽',
    week: 'Сколько в неделю, ₽', month: 'Сколько в месяц, ₽', goal: 'Сколько накопить, ₽',
  }[tType] || '';
  $('bc-thint').textContent = {
    day: '«Сегодня можно» на главном: сэкономленное вчера прибавится к сегодняшнему.',
    week: 'Делится на 7 дней — получится «Сегодня можно».',
    month: 'Например, подписки, связь, проездной.',
    goal: 'С датой — посчитаем, сколько откладывать каждый месяц. Без даты — просто копим.',
  }[tType] || '';
}

function readAssigned() {
  const v = $('bc-amount').value.trim();
  if (!v) return 0;
  const n = parseMoney(v);
  return n >= 0 ? n : null;
}

function renderCatInfo() {
  const r = ui.cat;
  const as = readAssigned() ?? r.assigned;
  const avail = r.carry + as - r.spent;
  $('bc-info').innerHTML = `
    ${r.carry ? `<div><span>С прошлого месяца</span><b>${fmt(r.carry)}</b></div>` : ''}
    <div><span>Назначено</span><b>${fmt(as)}</b></div>
    <div><span>Потрачено</span><b>${fmt(r.spent)}</b></div>
    <div><span>Осталось</span><b class="${avail < 0 ? 'negative' : 'income'}">${signed(avail)}</b></div>`;
  $('bc-move').textContent = avail < 0 ? '🩹 Покрыть перерасход из другой категории' : '↔ Перенести деньги в другую категорию';
  $('bc-move').hidden = avail === 0;
}

function readTarget() {
  if (tType === 'none') return null;
  const amount = parseMoney($('bc-tamount').value);
  if (!(amount > 0)) return false;
  const old = ui.cat.target;
  const t = { type: tType, amount };
  if (tType === 'day' && $('bc-wd').checked) {
    const we = parseMoney($('bc-weekend').value);
    if (!(we >= 0)) return false;
    t.weekdays = [amount, amount, amount, amount, amount, we, we];
    t.amount = Math.round((amount * 5 + we * 2) / 7);
  }
  if (tType === 'goal' && $('bc-tdate').value) t.date = $('bc-tdate').value;
  // Цель «в день/в неделю», поставленная посреди месяца, считается с сегодняшнего дня
  if (isDaily(t)) {
    if (old && isDaily(old) && old.since) t.since = old.since;
    else if (!old || !isDaily(old)) {
      const { from } = monthBounds(currentMonthKey());
      if (todayISO() > from) t.since = todayISO();
    }
  }
  return t;
}

async function saveCatSheet(e) {
  e?.preventDefault();
  const r = ui.cat;
  const as = readAssigned();
  if (as === null) { shake($('bc-amount')); return false; }
  const target = readTarget();
  if (target === false) { shake($('bc-tamount')); return false; }
  const cat = await db.get('categories', r.cat.id);
  if (target) cat.target = target; else delete cat.target;
  cat.group = ui.group;
  await db.put('categories', cat);
  if (as !== r.assigned) await setAssigned(ui.key, r.cat.id, as);
  closeSheet($('bud-cat-sheet'));
  document.dispatchEvent(new Event('categories-changed'));
  changed();
  return true;
}

// =====================================================================
// ПЕРЕНОС ДЕНЕГ / ПОКРЫТЬ ПЕРЕРАСХОД
// =====================================================================
async function openMoveSheet(catId, mode) {
  const b = await computeBudget(ui.key);
  ui.budget = b;
  const r = b.rows.find((x) => x.cat.id === catId);
  if (!r) return;
  ui.move = { r, mode };
  $('bm-title').textContent = mode === 'cover' ? 'Покрыть перерасход' : 'Перенести деньги';
  $('bm-card').innerHTML = `<span class="tx-emoji">${r.cat.emoji}</span>
    <span class="bud-main"><span class="bud-name">${escapeHTML(r.cat.name)}</span>
    <span class="bud-sub">назначено ${fmt(r.assigned)} · потрачено ${fmt(r.spent)}</span></span>
    <span class="bud-pill ${r.status}">${signed(r.available)}</span>`;
  $('bm-label').textContent = mode === 'cover' ? 'Взять из' : 'Куда перенести';

  let opts;
  if (mode === 'cover') {
    opts = b.rows.filter((x) => x !== r && x.available > 0).sort((a, c) => c.available - a.available)
      .map((x) => ({ id: x.cat.id, emoji: x.cat.emoji, name: x.cat.name, amount: x.available }));
    if (b.rta > 0) opts.push({ id: '__rta__', emoji: '💰', name: 'Готово к распределению', amount: b.rta });
  } else {
    opts = b.rows.filter((x) => x !== r)
      .map((x) => ({ id: x.cat.id, emoji: x.cat.emoji, name: x.cat.name, amount: x.available }));
    opts.unshift({ id: '__rta__', emoji: '💰', name: 'Вернуть в «Готово к распределению»', amount: null });
  }
  $('bm-list').innerHTML = opts.length ? opts.map((o, i) => `<label class="bm-opt">
      <input type="radio" name="bm-from" value="${o.id}" ${i === 0 ? 'checked' : ''}>
      <span class="bm-e">${o.emoji}</span><span class="bm-n">${escapeHTML(o.name)}</span>
      ${o.amount !== null ? `<span class="bm-a ${o.amount < 0 ? 'negative' : ''}">${signed(o.amount)}</span>` : ''}
    </label>`).join('')
    : '<p class="small muted" style="padding:12px 14px;margin:0">Свободных денег в других категориях нет. Добавьте деньги в «Мои деньги» или уменьшите назначенное.</p>';
  const def = mode === 'cover' ? -r.available : r.available;
  $('bm-amount').value = def > 0 ? moneyToInput(def) : '';
  renderMoveHint();
  openSheet($('bud-move-sheet'));
}

function renderMoveHint() {
  const m = ui.move;
  if (!m) return;
  const x = parseMoney($('bm-amount').value) || 0;
  const sel = document.querySelector('input[name=bm-from]:checked');
  const other = sel && ui.budget.rows.find((r) => r.cat.id === sel.value);
  const r = m.r;
  let text = '';
  if (x > 0) {
    const mine = m.mode === 'cover' ? r.available + x : r.available - x;
    text = `«${r.cat.name}» станет ${signed(mine)}`;
    if (other) text += `, «${other.cat.name}» — ${signed(m.mode === 'cover' ? other.available - x : other.available + x)}`;
    text += '.';
  }
  $('bm-hint').textContent = text;
}

async function saveMove(e) {
  e.preventDefault();
  const m = ui.move;
  const x = parseMoney($('bm-amount').value);
  if (!(x > 0)) { shake($('bm-amount')); return; }
  const sel = document.querySelector('input[name=bm-from]:checked');
  if (!sel) { toast('Выберите категорию'); return; }
  const a = await getAssigned(ui.key);
  const other = sel.value === '__rta__' ? null : sel.value;
  const before = { ...a };
  if (m.mode === 'cover') {
    if (other) a[other] = (a[other] || 0) - x;
    a[m.r.cat.id] = (a[m.r.cat.id] || 0) + x;
  } else {
    a[m.r.cat.id] = (a[m.r.cat.id] || 0) - x;
    if (other) a[other] = (a[other] || 0) + x;
  }
  await setAssignedMany(ui.key, a);
  closeSheets();
  changed();
  toast(`Перенесено ${fmt(x)}`, 4000, {
    label: 'Отменить',
    async onClick() { await setAssignedMany(ui.key, before); changed(); toast('Отменено'); },
  });
}

// =====================================================================
// ГРУППЫ
// =====================================================================
async function groupActions(id) {
  const meta = await getMeta();
  const i = meta.groups.findIndex((g) => g.id === id);
  const g = meta.groups[i];
  const save = async () => { await saveMeta(meta); changed(); };
  const items = [
    { label: '✏️ Переименовать', onClick: async () => {
      const name = prompt('Название группы', g.name);
      if (name && name.trim()) { g.name = name.trim().slice(0, 30); await save(); }
    } },
  ];
  if (i > 0) items.push({ label: '⬆️ Выше', onClick: async () => { meta.groups.splice(i - 1, 0, meta.groups.splice(i, 1)[0]); await save(); } });
  if (i < meta.groups.length - 1) items.push({ label: '⬇️ Ниже', onClick: async () => { meta.groups.splice(i + 1, 0, meta.groups.splice(i, 1)[0]); await save(); } });
  if (meta.groups.length > 1) {
    items.push({ label: '🗑 Удалить группу', sub: 'категории перейдут в другую группу', danger: true, onClick: async () => {
      if (!confirm(`Удалить группу «${g.name}»? Категории из неё перейдут в другую группу.`)) return;
      meta.groups.splice(i, 1);
      const to = groupOf({ group: null }, meta.groups);
      for (const c of await db.getAll('categories')) {
        if (c.group === id) { c.group = to; await db.put('categories', c); }
      }
      await save();
    } });
  }
  actionSheet(escapeHTML(g.name), items);
}

async function addGroup() {
  const name = prompt('Название новой группы', '');
  if (!name || !name.trim()) return;
  const meta = await getMeta();
  meta.groups.push({ id: 'g-' + db.newId(), name: name.trim().slice(0, 30) });
  await saveMeta(meta);
  changed();
  toast('Группа добавлена — откройте категорию и выберите её');
}

// =====================================================================
// ГЛАВНЫЙ ЭКРАН: «Сегодня можно» и строка плана
// =====================================================================
/** Возвращает id категорий с целью «в день/в неделю» (их ставим первыми в «+»). */
export async function renderHome(isCurrentMonth) {
  const hero = $('today-hero');
  const link = $('plan-card');
  if (!isCurrentMonth) { hero.innerHTML = ''; link.innerHTML = ''; return []; }
  const b = await withDailySpending(await computeBudget(currentMonthKey()));
  const rows = todayRows(b);

  link.innerHTML = b.money === null ? '' : `<button type="button" class="card plan-link" data-go-plan>
    <span>📨 План</span>
    <span class="pl-r"><small>${b.rta < 0 ? 'распределено больше, чем есть' : b.rta > 0 ? 'готово к распределению' : 'все деньги распределены'}</small>
    <b class="${b.rta < 0 ? 'negative' : b.rta > 0 ? 'pl-ok' : ''}">${b.rta === 0 ? '✓' : signed(b.rta)}</b></span>
    <span class="chev">›</span></button>`;

  const statusOf = (r) => r.remaining < 0 ? 'over' : r.todayLimit > 0 && r.spent / r.todayLimit >= 0.8 ? 'warn' : 'ok';
  const pctOf = (r) => r.todayLimit > 0 ? Math.min(100, Math.round((r.spent / r.todayLimit) * 100)) : 100;
  const carryText = (r) => r.carry === 0 ? ''
    : r.carry > 0 ? ` <span class="income">+${fmt(r.carry)} экономия</span>`
      : ` <span class="negative">−${fmt(-r.carry)} перерасход</span>`;

  if (rows.length) {
    const [main, ...rest] = rows;
    const s0 = statusOf(main);
    hero.innerHTML = `<section class="card hero">
      <button type="button" class="hero-main" data-quick-add="${main.category.id}">
        <span class="hero-label">${main.remaining < 0 ? 'Перерасход сегодня' : 'Сегодня можно'}</span>
        <span class="hero-amount ${s0}">${fmt(Math.abs(main.remaining))}</span>
        <span class="progress big limit-bar ${s0}"><i style="width:${pctOf(main)}%"></i></span>
        <span class="hero-sub">${main.category.emoji} ${escapeHTML(main.category.name)} · ${fmt(main.base)} ${main.target.weekdays ? 'на сегодня' : 'в день'}${carryText(main)}${main.remaining < 0 ? ' · <span class="negative">вычтется завтра</span>' : ''}</span>
      </button>
      ${rest.map((r) => `<button type="button" class="hero-row" data-quick-add="${r.category.id}">
        <span>${r.category.emoji} ${escapeHTML(r.category.name)}</span>
        <b class="today-val ${statusOf(r)}">${signed(r.remaining)}</b>
      </button>`).join('')}
    </section>`;
    return rows.map((r) => r.category.id);
  }

  // Целей «в день» нет: сколько можно тратить в день из повседневных категорий
  const daily = b.rows.filter((r) => r.group !== 'g-must' && r.group !== 'g-goals' && (!r.target || r.target.type !== 'goal'));
  const avail = daily.reduce((s, r) => s + Math.max(0, r.available), 0);
  const left = daysLeft(b.key);
  if (b.started && avail > 0 && left > 0) {
    hero.innerHTML = `<section class="card hero">
      <button type="button" class="hero-main" data-go-plan>
        <span class="hero-label">Можно тратить в день</span>
        <span class="hero-amount ok">≈ ${fmt(Math.floor(avail / left / 100) * 100)}</span>
        <span class="hero-sub">${fmt(avail)} в повседневных категориях на ${left} ${plural(left, 'день', 'дня', 'дней')}</span>
      </button>
    </section>`;
  } else if (!b.started) {
    hero.innerHTML = `<button type="button" class="card hero hero-empty" data-go-plan>
      <span class="hero-label">Сколько можно тратить?</span>
      <span class="hero-cta">Распределите деньги по категориям →</span>
    </button>`;
  } else hero.innerHTML = '';
  return [];
}

/** Сообщение после добавления траты. true — показали. */
export async function budgetToastAfterSave(tx, action = null) {
  if (tx.type !== 'expense' || tx.ownTransfer) return false;
  const key = tx.date.slice(0, 7);
  const b = await withDailySpending(await computeBudget(key));
  if (!b.started) return false;
  const r = b.rows.find((x) => x.cat.id === tx.categoryId);
  if (!r) return false;
  const name = `«${r.cat.name}»`;
  if (key === currentMonthKey() && tx.date === todayISO()) {
    const td = todayRows(b).find((x) => x.row === r);
    if (td) {
      if (td.remaining < 0) toast(`⛔ ${name}: на сегодня превышено на ${fmt(-td.remaining)} — вычтется завтра`, 4500, action);
      else toast(`${name}: на сегодня осталось ${fmt(td.remaining)}`, 3000, action);
      return true;
    }
  }
  if (!r.assigned && !r.carry) return false;
  if (r.available < 0) toast(`⛔ ${name}: перерасход ${fmt(-r.available)} — покройте в «Плане»`, 4500, action);
  else toast(`${name}: в конверте осталось ${fmt(r.available)}`, 3000, action);
  return true;
}

// =====================================================================
// ОБРАБОТЧИКИ
// =====================================================================
export function initBudgetUI() {
  $('bud-prev').addEventListener('click', () => { ui.key = shiftMonthKey(ui.key || currentMonthKey(), -1); renderPlanView(); });
  $('bud-next').addEventListener('click', () => { ui.key = shiftMonthKey(ui.key || currentMonthKey(), 1); renderPlanView(); });
  $('bud-today').addEventListener('click', () => { ui.key = currentMonthKey(); renderPlanView(); });
  $('bud-add-group').addEventListener('click', addGroup);

  $('view-plan').addEventListener('click', (e) => {
    const cover = e.target.closest('[data-cover]');
    if (cover) { openMoveSheet(cover.dataset.cover, 'cover'); return; }
    const row = e.target.closest('[data-cat]');
    if (row) { openCatSheet(row.dataset.cat); return; }
    const g = e.target.closest('[data-group]');
    if (g) { groupActions(g.dataset.group); return; }
    const act = e.target.closest('[data-bud]');
    if (act?.dataset.bud === 'wallet') openWalletSheet();
    if (act?.dataset.bud === 'assign') openAssignMenu();
  });

  // Окно категории
  $('bud-cat-sheet').addEventListener('submit', saveCatSheet);
  $('bc-amount').addEventListener('input', renderCatInfo);
  $('bc-quick').addEventListener('click', (e) => {
    const bt = e.target.closest('[data-v]');
    if (!bt) return;
    $('bc-amount').value = moneyToInput(Number(bt.dataset.v));
    renderCatInfo();
  });
  $('bc-ttype').addEventListener('click', (e) => {
    const bt = e.target.closest('[data-t]');
    if (!bt) return;
    tType = bt.dataset.t;
    renderTarget();
  });
  $('bc-wd').addEventListener('change', renderTarget);
  $('bc-groups').addEventListener('click', (e) => {
    const bt = e.target.closest('[data-g]');
    if (!bt) return;
    ui.group = bt.dataset.g;
    renderGroupChips();
  });
  $('bc-move').addEventListener('click', async () => {
    const r = ui.cat;
    // Сначала сохраняем то, что ввели, потом открываем перенос
    if (!(await saveCatSheet())) return;
    const as = readAssigned() ?? r.assigned;
    openMoveSheet(r.cat.id, r.carry + as - r.spent < 0 ? 'cover' : 'move');
  });

  // Перенос
  $('bud-move-sheet').addEventListener('submit', saveMove);
  $('bm-amount').addEventListener('input', renderMoveHint);
  $('bm-list').addEventListener('change', renderMoveHint);
}

export { TTYPES };

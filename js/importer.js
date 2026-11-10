// =====================================================================
// importer.js — импорт выписки из банка (Настройки → «Импорт выписки»).
//
//  1. readTable() читает CSV/Excel в таблицу строк.
//  2. detectColumns() находит строку заголовков и колонки: дата, сумма
//     (или «приход»/«расход»), описание, категория банка, статус.
//  3. Каждой операции подбираем категорию: по прошлым импортам,
//     по названию магазина, по категории банка.
//  4. Уже внесённые операции помечаем — по умолчанию они не выбраны.
//  5. Пользователь проверяет список и нажимает «Импортировать».
// =====================================================================

import * as db from './db.js';
import { readTable, parseDate, parseAmount } from './importparse.js';
import { formatMoney, escapeHTML, shortDate, MONTHS } from './utils.js';
import { $, openSheet, closeSheet, toast } from './ui.js';

// ---------------------------------------------------------------------
// Колонки
// ---------------------------------------------------------------------
const ROLES = {
  date: { label: 'Дата', words: ['дата операции', 'дата проводки', 'дата совершения', 'дата платежа', 'дата', 'date'] },
  amount: { label: 'Сумма', words: ['сумма операции', 'сумма в валюте счета', 'сумма в рублях', 'сумма платежа', 'сумма', 'amount'], not: ['кэшбэк', 'бонус', 'округл', 'комисс'] },
  debit: { label: 'Расход', words: ['расход', 'списание', 'дебет', 'debit'] },
  credit: { label: 'Приход', words: ['приход', 'поступление', 'зачисление', 'credit'] },
  description: { label: 'Описание', words: ['описание', 'назначение', 'наименование', 'контрагент', 'получатель', 'детали', 'место', 'description'] },
  category: { label: 'Категория банка', words: ['категория', 'category'] },
  status: { label: 'Статус', words: ['статус', 'status'] },
};

/** Найти строку заголовков и номера колонок. */
export function detectColumns(rows) {
  let best = { score: 0, index: -1, cols: {} };
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = rows[i].map((c) => String(c).toLowerCase());
    const cols = {};
    let score = 0;
    for (const [role, def] of Object.entries(ROLES)) {
      for (const w of def.words) {
        const k = cells.findIndex((c, j) => c.includes(w) && !(def.not || []).some((x) => c.includes(x))
          && !Object.values(cols).includes(j));
        if (k >= 0) { cols[role] = k; score++; break; }
      }
    }
    if ((cols.date !== undefined) && (cols.amount !== undefined || cols.debit !== undefined) && score > best.score) {
      best = { score, index: i, cols };
    }
  }
  if (best.index >= 0) return { headerIndex: best.index, cols: best.cols, headers: rows[best.index] };
  return guessWithoutHeader(rows);
}

/** Заголовков нет — угадываем по содержимому: дата, число, самый длинный текст. */
function guessWithoutHeader(rows) {
  const sample = rows.slice(0, 30);
  const width = Math.max(...sample.map((r) => r.length));
  const share = (test) => [...Array(width).keys()].map((j) => sample.filter((r) => test(r[j])).length);
  const dateScore = share((v) => parseDate(v));
  const numScore = share((v) => v && parseAmount(v) !== null && !parseDate(v));
  const textLen = [...Array(width).keys()].map((j) => sample.reduce((s, r) => s + (r[j] && parseAmount(r[j]) === null ? r[j].length : 0), 0));
  const argmax = (a, skip = []) => a.reduce((bi, v, i) => (!skip.includes(i) && v > (a[bi] ?? -1) ? i : bi), skip.includes(0) ? 1 : 0);
  const date = argmax(dateScore);
  const amount = argmax(numScore, [date]);
  const description = argmax(textLen, [date, amount]);
  return { headerIndex: -1, cols: { date, amount, description }, headers: [...Array(width).keys()].map((j) => `Колонка ${j + 1}`) };
}

// ---------------------------------------------------------------------
// Операции из строк
// ---------------------------------------------------------------------
const BAD_STATUS = ['failed', 'отклон', 'отмен', 'declin', 'error', 'ошибк'];
const OWN_TRANSFER = ['между своими', 'между собственными', 'на свой счет', 'на свой счёт', 'перевод себе'];

/** Строки таблицы → операции { date, amount (копейки, >0), type, description, bankCategory, skip? } */
export function toOperations(rows, det) {
  const { cols, headerIndex } = det;
  const ops = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    const date = parseDate(r[cols.date]);
    if (!date) continue;
    let value = null;
    if (cols.debit !== undefined || cols.credit !== undefined) {
      const d = parseAmount(r[cols.debit]) || 0;
      const c = parseAmount(r[cols.credit]) || 0;
      if (d || c) value = Math.abs(c) - Math.abs(d);
    }
    if (value === null && cols.amount !== undefined) value = parseAmount(r[cols.amount]);
    if (!value) continue;
    const status = cols.status !== undefined ? String(r[cols.status]).toLowerCase() : '';
    const description = cols.description !== undefined ? r[cols.description] : '';
    const bankCategory = cols.category !== undefined ? r[cols.category] : '';
    const low = (description + ' ' + bankCategory).toLowerCase();
    ops.push({
      date, signed: value, amount: Math.abs(value), description, bankCategory,
      skip: BAD_STATUS.some((w) => status.includes(w)) ? 'отклонена'
        : OWN_TRANSFER.some((w) => low.includes(w)) ? 'перевод между своими счетами' : null,
    });
  }
  // Все суммы положительные и нет колонок прихода/расхода — значит, это траты
  const allPositive = ops.every((o) => o.signed > 0) && cols.debit === undefined && cols.credit === undefined;
  for (const o of ops) o.type = allPositive || o.signed < 0 ? 'expense' : 'income';
  return ops;
}

// ---------------------------------------------------------------------
// Категории
// ---------------------------------------------------------------------
// Ключевые слова → название нашей категории (по умолчанию)
const KEYWORDS = [
  ['Еда', ['супермаркет', 'продукт', 'фастфуд', 'ресторан', 'кафе', 'кофе', 'пятерочк', 'пятёрочк', 'магнит', 'перекрест', 'вкусвилл', 'лента', 'ашан', 'дикси', 'окей', 'metro', 'spar', 'макдон', 'вкусно', 'kfc', 'бургер', 'burger', 'самокат', 'яндекс еда', 'яндекс лавка', 'delivery', 'пекарн', 'шоколадниц', 'додо', 'food']],
  ['Транспорт', ['транспорт', 'такси', 'taxi', 'яндекс go', 'yandex go', 'uber', 'метро', 'metro moscow', 'мосметро', 'тройка', 'автобус', 'азс', 'топливо', 'бензин', 'лукойл', 'роснефть', 'газпромнефть', 'каршеринг', 'делимобиль', 'ситидрайв', 'ржд', 'аэрофлот', 'парковк']],
  ['Жильё', ['жкх', 'коммунал', 'квартплат', 'аренда', 'электроэнерг', 'мосэнерго', 'водоканал']],
  ['Связь', ['связь', 'мобильн', 'мтс', 'билайн', 'мегафон', 'теле2', 't2', 'интернет', 'ростелеком']],
  ['Здоровье', ['аптек', 'медицин', 'здоров', 'клиник', 'стоматолог', 'apteka', 'pharm']],
  ['Одежда', ['одежд', 'обув', 'zara', 'uniqlo', 'lamoda', 'спортмастер', 'gloria']],
  ['Развлечения', ['развлеч', 'кино', 'театр', 'концерт', 'игр', 'steam', 'кинопоиск', 'яндекс плюс', 'okko', 'ivi', 'spotify', 'музык']],
  ['Подарки', ['подарк', 'цвет']],
  ['Зарплата', ['зарплат', 'заработн', 'аванс', 'salary']],
];

const normalize = (s) => String(s || '').toLowerCase().replace(/[0-9*#№"'«».,:;()\-_/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

async function loadRules() {
  return (await db.get('settings', 'importRules'))?.map || {};
}
async function saveRules(map) {
  await db.put('settings', { id: 'importRules', map });
}

/** Подобрать категорию: прошлые импорты → категория банка совпадает с нашей → ключевые слова → «Другое». */
function guessCategory(op, categories, rules) {
  const cats = categories.filter((c) => c.type === op.type && !c.archived);
  const byName = (name) => cats.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const learned = rules[normalize(op.description)];
  if (learned && cats.some((c) => c.id === learned)) return learned;
  if (op.bankCategory) {
    const same = byName(op.bankCategory);
    if (same) return same.id;
  }
  const text = `${op.description} ${op.bankCategory}`.toLowerCase();
  for (const [name, words] of KEYWORDS) {
    if (words.some((w) => text.includes(w))) {
      const c = byName(name);
      if (c) return c.id;
    }
  }
  return (byName('Другое') || cats[cats.length - 1] || {}).id || null;
}

// ---------------------------------------------------------------------
// Окно импорта
// ---------------------------------------------------------------------
const st = {
  fileName: '', format: '', rows: [], det: null,
  ops: [],          // { ...операция, categoryId, checked, dup }
  month: 'all',     // 'all' или 'ГГГГ-ММ'
  categories: [],
};

const importKey = (op) => `${op.date}|${op.type}|${op.amount}|${normalize(op.description)}`;

async function prepare() {
  const rules = await loadRules();
  st.categories = await db.getAll('categories');
  const ops = toOperations(st.rows, st.det);
  if (!ops.length) { st.ops = []; return; }
  const dates = ops.map((o) => o.date).sort();
  const existing = await db.getTransactionsBetween(dates[0], dates[dates.length - 1]);
  const keys = new Set(existing.map((t) => t.importKey).filter(Boolean));
  const manual = existing.filter((t) => !t.importKey).map((t) => `${t.date}|${t.type}|${t.amount}`);
  st.ops = ops.map((o) => {
    const dup = keys.has(importKey(o)) ? 'уже импортирована'
      : manual.includes(`${o.date}|${o.type}|${o.amount}`) ? 'похоже, уже внесена вручную' : null;
    return { ...o, categoryId: guessCategory(o, st.categories, rules), dup, checked: !dup && !o.skip };
  });
  // Месяц по умолчанию — все
  st.month = 'all';
}

function visibleOps() {
  return st.ops.filter((o) => st.month === 'all' || o.date.startsWith(st.month));
}

function render() {
  $('imp-file').textContent = `${st.fileName} · ${st.format}`;
  // Месяцы из файла
  const months = [...new Set(st.ops.map((o) => o.date.slice(0, 7)))].sort();
  $('imp-months').innerHTML = (months.length > 1 ? [['all', 'Все месяцы']] : [])
    .concat(months.map((m) => [m, `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`]))
    .map(([k, l]) => `<button type="button" data-month="${k}" class="${st.month === k || (months.length === 1) ? 'active' : ''}">${l}</button>`).join('');

  // Колонки — можно поправить
  const headers = st.det.headers;
  const opt = (role) => `<option value="">—</option>` + headers.map((h, j) =>
    `<option value="${j}" ${st.det.cols[role] === j ? 'selected' : ''}>${escapeHTML(h || `Колонка ${j + 1}`)}</option>`).join('');
  $('imp-cols').innerHTML = Object.entries(ROLES).map(([role, def]) => `
    <label class="imp-col"><span>${def.label}</span><select data-role="${role}">${opt(role)}</select></label>`).join('');

  const ops = visibleOps();
  const chosen = ops.filter((o) => o.checked);
  const exp = chosen.filter((o) => o.type === 'expense').reduce((s, o) => s + o.amount, 0);
  const inc = chosen.filter((o) => o.type === 'income').reduce((s, o) => s + o.amount, 0);
  const dups = ops.filter((o) => o.dup).length;
  $('imp-summary').innerHTML = ops.length
    ? `Операций: <b>${ops.length}</b> · выбрано ${chosen.length}<br>
       Расходы <b>${formatMoney(exp)}</b> · доходы <b class="income">${formatMoney(inc)}</b>
       ${dups ? `<br><span class="muted">Уже есть в приложении: ${dups} — они не отмечены</span>` : ''}`
    : '<span class="negative">Не нашёл операций. Проверьте колонки ниже — особенно «Дата» и «Сумма».</span>';
  $('imp-go').textContent = `Импорт (${chosen.length})`;
  $('imp-go').disabled = !chosen.length;

  const catOptions = (type, sel) => st.categories
    .filter((c) => c.type === type && !c.archived)
    .sort((a, b) => a.order - b.order)
    .map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${c.emoji} ${escapeHTML(c.name)}</option>`).join('');

  $('imp-list').innerHTML = ops.map((o) => {
    const i = st.ops.indexOf(o);
    return `<div class="imp-row ${o.checked ? '' : 'off'}" data-i="${i}">
      <input type="checkbox" class="imp-check" ${o.checked ? 'checked' : ''} aria-label="Импортировать">
      <div class="imp-main">
        <div class="imp-top"><span class="imp-date">${shortDate(o.date)}</span>
          <b class="${o.type === 'income' ? 'income' : ''}">${o.type === 'income' ? '+' : '−'}${formatMoney(o.amount)}</b></div>
        <div class="imp-desc">${escapeHTML(o.description || o.bankCategory || 'Без описания')}</div>
        ${o.dup || o.skip ? `<div class="imp-note">${o.dup || o.skip}</div>` : ''}
        <select class="imp-cat">${catOptions(o.type, o.categoryId)}</select>
      </div>
    </div>`;
  }).join('');
}

export async function startImport(file) {
  try {
    const { rows, format } = await readTable(file);
    st.fileName = file.name;
    st.format = format;
    st.rows = rows;
    st.det = detectColumns(rows);
    await prepare();
    render();
    openSheet($('imp-sheet'));
  } catch (e) {
    console.error(e);
    toast(e.message || 'Не удалось прочитать файл', 4500);
  }
}

async function doImport() {
  const chosen = visibleOps().filter((o) => o.checked);
  if (!chosen.length) return;
  const rules = await loadRules();
  let n = 0;
  for (const o of chosen) {
    await db.put('transactions', {
      id: db.newId(), createdAt: Date.now() + n, type: o.type, amount: o.amount,
      categoryId: o.categoryId, date: o.date, comment: o.description.slice(0, 120), importKey: importKey(o),
    });
    // Запоминаем: ваш выбор — всегда, автоматический — только если правила ещё нет
    const key = normalize(o.description);
    if (key && (o.userSet || !rules[key])) rules[key] = o.categoryId;
    n++;
  }
  await saveRules(rules);
  try { localStorage.setItem('lastImport', new Date().toISOString().slice(0, 10)); } catch { /* ничего */ }
  closeSheet($('imp-sheet'));
  toast(`Импортировано: ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'запись' : 'записей'} ✓`, 3000);
  document.dispatchEvent(new Event('categories-changed')); // перерисовать траты, план, статистику
  renderImportCard();
}

/** Карточка в настройках: когда был последний импорт. */
export function renderImportCard() {
  let last = null;
  try { last = localStorage.getItem('lastImport'); } catch { /* ничего */ }
  $('imp-last').textContent = last ? `Последний импорт: ${shortDate(last)}` : 'Выписку ещё не загружали';
}

export function initImport() {
  $('imp-file-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) startImport(f);
  });
  $('imp-go').addEventListener('click', doImport);
  $('imp-months').addEventListener('click', (e) => {
    const b = e.target.closest('[data-month]');
    if (!b) return;
    st.month = b.dataset.month;
    render();
  });
  $('imp-cols').addEventListener('change', async (e) => {
    const sel = e.target.closest('select');
    if (!sel) return;
    if (sel.value === '') delete st.det.cols[sel.dataset.role];
    else st.det.cols[sel.dataset.role] = Number(sel.value);
    await prepare();
    render();
  });
  $('imp-list').addEventListener('change', (e) => {
    const row = e.target.closest('.imp-row');
    if (!row) return;
    const o = st.ops[Number(row.dataset.i)];
    if (e.target.classList.contains('imp-check')) { o.checked = e.target.checked; render(); }
    if (e.target.classList.contains('imp-cat')) {
      // Меняем категорию у всех таких же операций (тот же магазин) и запоминаем выбор
      const key = normalize(o.description);
      let same = 0;
      for (const x of st.ops) {
        if (x.type === o.type && (x === o || (key && normalize(x.description) === key))) {
          x.categoryId = e.target.value; x.userSet = true; same++;
        }
      }
      if (same > 1) { render(); toast(`Категория изменена у ${same} похожих операций`); }
    }
  });
  $('imp-all').addEventListener('click', () => {
    const ops = visibleOps();
    const all = ops.every((o) => o.checked);
    for (const o of ops) o.checked = !all;
    render();
  });
  $('imp-help-btn').addEventListener('click', () => {
    $('imp-help').hidden = !$('imp-help').hidden;
  });
  renderImportCard();
}

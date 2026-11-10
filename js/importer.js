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
  mcc: { label: 'MCC', words: ['mcc'] },
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
const OWN_TRANSFER = ['между своими', 'между собственными', 'между счетами', 'на свой счет', 'на свой счёт', 'перевод себе',
  'погашение од', 'погашение основного долга', 'собственных средств'];

// Категории банка, которые ничего не говорят (у Альфы почти всё — «Прочие операции»)
const MEANINGLESS_CATEGORY = /^(прочие операции|прочие расходы|прочее|другое|разное)$/i;

/**
 * Достаём из описания самое полезное.
 *  Альфа: «Операция по карте: 2200…0983, дата создания транзакции: 12-10-2026,
 *          место совершения операции: RU/MOSCOW/AV .AZBUKAVKUSA, MCC: 5411»
 *          → описание «AV .AZBUKAVKUSA», город «MOSCOW», MCC 5411.
 *  «Категория: Штрафы ГАИ.Оплата штрафа…» → категория банка «Штрафы ГАИ».
 *  MCC — код типа магазина; по нему надёжно понятна категория.
 */
function enrich(o) {
  let d = String(o.description || '').replace(/\s+/g, ' ').trim();
  const mcc = d.match(/MCC:?\s*(\d{4})/i);
  if (mcc && !o.mcc) o.mcc = mcc[1];
  const place = d.match(/место совершения операции:\s*(.+?)(?:,\s*MCC:?\s*\d{4})?\s*$/i);
  if (place) {
    const parts = place[1].split('/');
    o.city = parts.length >= 3 ? parts[1] : '';
    d = (parts.length >= 3 ? parts.slice(2).join('/') : place[1]).trim();
  }
  const cat = d.match(/^Категория:\s*([^.]+)\.\s*(.*)$/i);
  if (cat) { o.bankCategory = cat[1].trim(); d = cat[2].trim(); }
  if (o.bankCategory && MEANINGLESS_CATEGORY.test(String(o.bankCategory).trim())) o.bankCategory = '';
  // Хвосты из номеров документов и реквизитов: «…по постановлению 1881057726… 0310064300…»
  d = d.replace(/\s*(по постановлению|дог\.?|договор)?\s*[\w#№]*\d{10,}.*$/i, '').trim() || d;
  o.description = d.slice(0, 120);
  return o;
}

// MCC → категория (первая из списка, которая у вас есть)
const MCC_MAP = [
  [['Продукты', 'Еда/Напитки', 'Еда'], [5411, 5422, 5441, 5451, 5499, 5300]],
  [['Рестораны', 'Еда/Напитки', 'Еда'], [5462, 5812, 5813, 5814]],
  [['Транспорт'], [4111, 4112, 4121, 4131, 4784, 4789, 5172, 5541, 5542, 7511, 7523, 7512]],
  [['Здоровье'], [5912, 5122, 5047, 8011, 8021, 8031, 8041, 8042, 8043, 8049, 8050, 8062, 8071, 8099]],
  [['Связь', 'Подписки'], [4812, 4814, 4899]],
  [['Подписки', 'Развлечения'], [5815, 5816, 5817, 5818, 7841]],
  [['Покупки', 'Одежда'], [5949, 5200, 5251, 5311, 5331, 5399, 5651, 5655, 5661, 5691, 5699, 5712, 5719, 5722, 5732, 5734, 5942, 5943, 5945, 5964, 5977, 5992, 5999]],
  [['Развлечения'], [7832, 7922, 7991, 7996, 7997, 7999]],
  [['Путешествия', 'Отдых'], [4411, 4511, 4722, 7011]],
  [['Переводы'], [4829, 6012, 6051, 6536, 6538]],
  [['Штрафы', 'Налоги'], [9222, 9311]],
];
function mccNames(mcc) {
  const n = Number(mcc);
  if (!n) return null;
  const hit = MCC_MAP.find(([, codes]) => codes.includes(n));
  return hit ? hit[0] : null;
}

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
    // HOLD — операция ещё не подтверждена банком (у Альфы в колонке «Дата проводки»)
    const pending = r.some((c) => String(c).trim().toUpperCase() === 'HOLD');
    const description = cols.description !== undefined ? r[cols.description] : '';
    const bankCategory = cols.category !== undefined ? r[cols.category] : '';
    const low = (description + ' ' + bankCategory).toLowerCase();
    ops.push({
      date, signed: value, amount: Math.abs(value), description, bankCategory, pending,
      mcc: cols.mcc !== undefined ? String(r[cols.mcc] || '').trim() : '',
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
// Ключевые слова → в какую категорию (берётся первая из списка, которая у вас есть).
// Порядок важен: сначала переводы и подписки, потом остальное.
const KEYWORDS = [
  [['Переводы'], ['перевод', 'сбп', 'transfer']],
  [['Зарплата'], ['зарплат', 'заработн', 'аванс', 'salary']],
  [['Подписки', 'Развлечения'], ['подписк', 'кинопоиск', 'яндекс плюс', 'yandex plus', 'okko', 'ivi', 'spotify', 'apple.com', 'itunes', 'google play', 'netflix', 'youtube', 'chatgpt', 'openai', 'neurabot', 'нейросет', 'vk музыка', 'звук']],
  [['Рестораны', 'Еда/Напитки', 'Еда'], ['ресторан', 'кафе', 'кофе', 'coffee', 'фастфуд', 'vkusno', 'вкусно', 'kfc', 'rostic', 'бургер', 'burger', 'макдон', 'mcdonald', 'додо', 'шоколадниц', 'пекарн', 'яндекс еда', 'delivery club', 'суши', 'пицц', 'бар ']],
  [['Продукты', 'Еда/Напитки', 'Еда'], ['супермаркет', 'продукт', 'пятерочк', 'пятёрочк', 'pyaterochka', 'магнит', 'magnit', 'перекрест', 'perekrestok', 'вкусвилл', 'vkusvill', 'лента', 'ашан', 'auchan', 'дикси', 'окей', 'metro', 'spar', 'самокат', 'samokat', 'яндекс лавка', 'лавка', 'globus', 'глобус', 'bianchi']],
  [['Транспорт'], ['fasten', 'yandex 4121', 'strelkacard', 'transport', 'транспорт', 'такси', 'taxi', 'yandex*taxi', 'яндекс go', 'yandex go', 'uber', 'метро', 'мосметро', 'тройка', 'автобус', 'азс', 'топливо', 'бензин', 'лукойл', 'роснефть', 'газпромнефть', 'каршеринг', 'делимобиль', 'ситидрайв', 'ржд', 'аэрофлот', 'парковк']],
  [['Здоровье'], ['аптек', 'медицин', 'здоров', 'клиник', 'стоматолог', 'apteka', 'apt ', 'pharm', 'invitro', 'инвитро', 'poliklin', 'polikli', 'klinik', 'gemotest', 'гемотест']],
  [['Покупки', 'Одежда'], ['маркетплейс', 'ozon', 'озон', 'wildberries', 'вайлдберриз', 'яндекс маркет', 'aliexpress', 'одежд', 'обув', 'zara', 'uniqlo', 'lamoda', 'спортмастер', 'gloria', 'dns', 'м.видео', 'эльдорадо', 'леруа', 'икеа', 'hoff', 'fix price']],
  [['Связь', 'Подписки'], ['связь', 'мобильн', 'мтс', 'билайн', 'мегафон', 'теле2', 't2', 'интернет', 'ростелеком']],
  [['Жильё'], ['жкх', 'коммунал', 'квартплат', 'аренда', 'электроэнерг', 'мосэнерго', 'водоканал']],
  [['Развлечения', 'Подписки'], ['развлеч', 'кино', 'театр', 'концерт', 'игр', 'steam', 'музык']],
  [['Подарки', 'Подарок'], ['подарк', 'цвет']],
];

const normalize = (s) => String(s || '').toLowerCase().replace(/[0-9*#№"'«».,:;()\-_/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

async function loadRules() {
  return (await db.get('settings', 'importRules'))?.map || {};
}
async function saveRules(map) {
  await db.put('settings', { id: 'importRules', map });
}

/**
 * Подобрать категорию: прошлые импорты (по описанию, потом по категории банка)
 * → категория банка совпадает с нашей → ключевые слова → «Другое».
 * Возвращает { id, recognized } — recognized: false, если ушло в «Другое» по умолчанию.
 */
function guessCategory(op, categories, rules) {
  const cats = categories.filter((c) => c.type === op.type && !c.archived);
  const byName = (name) => cats.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const ok = (id) => id && cats.some((c) => c.id === id);
  const learned = rules[normalize(op.description)];
  if (ok(learned)) return { id: learned, recognized: true };
  const learnedCat = op.bankCategory && rules[bankKey(op)];
  if (ok(learnedCat)) return { id: learnedCat, recognized: true };
  if (op.bankCategory) {
    const same = byName(op.bankCategory);
    if (same) return { id: same.id, recognized: true };
  }
  const text = `${op.description} ${op.bankCategory}`.toLowerCase();
  for (const [names, words] of KEYWORDS) {
    if (words.some((w) => text.includes(w))) {
      const c = names.map(byName).find(Boolean);
      if (c) return { id: c.id, recognized: true };
    }
  }
  // Код типа магазина (MCC)
  const byMcc = mccNames(op.mcc);
  if (byMcc) {
    const c = byMcc.map(byName).find(Boolean);
    if (c) return { id: c.id, recognized: true };
  }
  return { id: (byName('Другое') || cats[cats.length - 1] || {}).id || null, recognized: false };
}

/** Ключ правила по категории банка: «cat:expense:перевод сбп». */
const bankKey = (op) => `cat:${op.type}:${String(op.bankCategory).toLowerCase().trim()}`;

/** Группа для блока «Не распознано»: по категории банка, иначе по описанию. */
const groupKey = (op) => `${op.type}|${op.bankCategory ? 'c:' + op.bankCategory.toLowerCase() : 'd:' + normalize(op.description).slice(0, 24)}`;

// ---------------------------------------------------------------------
// Окно импорта
// ---------------------------------------------------------------------
const st = {
  fileName: '', format: '', rows: [], det: null,
  pdfOps: null,     // операции из PDF (тогда колонок нет)
  leftOther: false, // нажали «Оставить в «Другое»»
  ops: [],          // { ...операция, categoryId, checked, dup, removed }
  month: 'all',     // 'all' или 'ГГГГ-ММ'
  categories: [],
};

const importKey = (op) => `${op.date}|${op.type}|${op.amount}|${normalize(op.description)}`;

async function prepare() {
  const rules = await loadRules();
  st.categories = await db.getAll('categories');
  const ops = (st.pdfOps ? st.pdfOps.map((o) => ({ ...o })) : toOperations(st.rows, st.det)).map(enrich);
  for (const o of ops) {
    if (!o.skip) {
      const low = `${o.description} ${o.bankCategory}`.toLowerCase();
      o.skip = OWN_TRANSFER.some((w) => low.includes(w)) ? 'перевод между своими счетами' : null;
    }
  }
  if (!ops.length) { st.ops = []; return; }
  const dates = ops.map((o) => o.date).sort();
  const existing = await db.getTransactionsBetween(dates[0], dates[dates.length - 1]);
  const keys = new Set(existing.map((t) => t.importKey).filter(Boolean));
  // Та же дата, тип и сумма — похоже, запись уже есть (внесена вручную или прошлым импортом)
  const same = existing.map((t) => `${t.date}|${t.type}|${t.amount}`);
  st.ops = ops.map((o) => {
    const dup = keys.has(importKey(o)) ? 'уже импортирована'
      : same.includes(`${o.date}|${o.type}|${o.amount}`) ? 'похоже, уже есть в приложении' : null;
    const g = guessCategory(o, st.categories, rules);
    return { ...o, categoryId: g.id, unrecognized: !g.recognized, dup, checked: !dup && !o.skip };
  });
  st.leftOther = false;
  // Месяц по умолчанию — все
  st.month = 'all';
}

function visibleOps() {
  return st.ops.filter((o) => !o.removed && (st.month === 'all' || o.date.startsWith(st.month)));
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
  $('imp-details').hidden = !!st.pdfOps;
  if (st.pdfOps) $('imp-cols').innerHTML = '';
  else $('imp-cols').innerHTML = Object.entries(ROLES).map(([role, def]) => `
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
  renderUnrecognized(ops);
  const word = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'операцию' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'операции' : 'операций');
  $('imp-go').textContent = `Добавить (${chosen.length})`;
  $('imp-go').disabled = !chosen.length;
  $('imp-go2').textContent = chosen.length ? `Добавить ${chosen.length} ${word(chosen.length)}` : 'Ничего не выбрано';
  $('imp-go2').disabled = !chosen.length;
  const removed = st.ops.filter((o) => o.removed).length;
  $('imp-removed').hidden = !removed;
  $('imp-removed').innerHTML = `Убрано из списка: ${removed} · <button type="button" class="link-btn small-link" id="imp-restore">Вернуть все</button>`;

  const catOptions = (type, sel) => st.categories
    .filter((c) => c.type === type && !c.archived)
    .sort((a, b) => a.order - b.order)
    .map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${c.emoji} ${escapeHTML(c.name)}</option>`).join('');

  $('imp-list').innerHTML = ops.map((o) => {
    const i = st.ops.indexOf(o);
    return `<div class="imp-row ${o.checked ? '' : 'off'}" data-i="${i}">
      <input type="checkbox" class="imp-check" ${o.checked ? 'checked' : ''} aria-label="Добавить эту операцию">
      <div class="imp-main">
        <div class="imp-top"><span class="imp-date">${shortDate(o.date)}</span>
          <b class="${o.type === 'income' ? 'income' : ''}">${o.type === 'income' ? '+' : '−'}${formatMoney(o.amount)}</b></div>
        <div class="imp-desc">${escapeHTML(o.description || o.bankCategory || 'Без описания')}</div>
        ${o.bankCategory || o.mcc ? `<div class="imp-meta">${escapeHTML([o.bankCategory, o.mcc ? 'MCC ' + o.mcc : ''].filter(Boolean).join(' · '))}</div>` : ''}
        ${o.dup || o.skip || o.pending ? `<div class="imp-note">${o.dup || o.skip || 'ещё не подтверждена банком (HOLD)'}</div>` : ''}
        <select class="imp-cat">${catOptions(o.type, o.categoryId)}</select>
      </div>
      <button type="button" class="imp-remove" aria-label="Убрать из списка">✕</button>
    </div>`;
  }).join('');
}

/** Нераспознанные операции, которые ещё не разобрали: группы. */
function unresolvedGroups(ops) {
  const groups = new Map();
  for (const o of ops) {
    if (!o.unrecognized || o.userSet || !o.checked) continue;
    const k = groupKey(o);
    if (!groups.has(k)) groups.set(k, { key: k, type: o.type, label: o.bankCategory || o.description || 'Без описания', ops: [] });
    groups.get(k).ops.push(o);
  }
  return [...groups.values()].sort((a, b) => b.ops.length - a.ops.length);
}

/** Блок «❓ Не распознано»: привязать группу к категории, создать новую или оставить в «Другое». */
function renderUnrecognized(ops) {
  const box = $('imp-unrec');
  const groups = st.leftOther ? [] : unresolvedGroups(ops);
  if (!groups.length) { box.innerHTML = ''; return; }
  const total = groups.reduce((s, g) => s + g.ops.length, 0);
  const options = (type) => `<option value="">Выберите категорию…</option>` + st.categories
    .filter((c) => c.type === type && !c.archived).sort((a, b) => a.order - b.order)
    .map((c) => `<option value="${c.id}">${c.emoji} ${escapeHTML(c.name)}</option>`).join('')
    + '<option value="__new__">＋ Новая категория…</option>';
  box.innerHTML = `<section class="card unrec">
    <div class="unrec-head"><b>❓ Не распознано: ${total} ${total % 10 === 1 && total % 100 !== 11 ? 'операция' : 'операций'}</b></div>
    <p class="small muted" style="margin:4px 0 8px">Привяжите к категориям — приложение запомнит и в следующий раз распознает само.</p>
    ${groups.map((g) => `<div class="unrec-row" data-group="${escapeHTML(g.key)}">
      <div class="unrec-label">
        <span>${escapeHTML(g.label)} <small class="muted">· ${g.type === 'income' ? 'пополнения' : 'списания'}</small></span>
        <small class="muted">${g.ops.length} шт. · ${g.type === 'income' ? '+' : '−'}${formatMoney(g.ops.reduce((s, o) => s + o.amount, 0))}</small>
      </div>
      <select class="unrec-select">${options(g.type)}</select>
    </div>`).join('')}
    <button type="button" class="secondary-btn full" id="unrec-skip">Пропустить — оставить в «Другое»</button>
  </section>`;
}

/** Привязать всю группу к категории (и запомнить для категории банка). */
function assignGroup(key, categoryId) {
  for (const o of st.ops) {
    if (groupKey(o) === key) { o.categoryId = categoryId; o.userSet = true; o.groupSet = true; }
  }
}

async function createCategory(type) {
  const name = (prompt('Название новой категории', '') || '').trim().slice(0, 30);
  if (!name) return null;
  const existing = st.categories.find((c) => c.type === type && !c.archived && c.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const order = Math.max(-1, ...st.categories.filter((c) => c.type === type).map((c) => c.order)) + 1;
  const cat = { id: db.newId(), type, name, emoji: type === 'income' ? '💰' : '🏷️', order, archived: false };
  await db.put('categories', cat);
  st.categories.push(cat);
  document.dispatchEvent(new Event('categories-changed'));
  toast(`Категория «${name}» создана — эмодзи можно поменять в настройках`, 3000);
  return cat.id;
}

export async function startImport(file) {
  try {
    const res = await readTable(file);
    st.fileName = file.name;
    st.format = res.format;
    st.pdfOps = res.ops || null;
    st.rows = res.rows || [];
    st.det = res.rows ? detectColumns(res.rows) : { cols: {}, headers: [], headerIndex: -1 };
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
  // Предупреждение: нераспознанные операции уйдут в «Другое»
  if (!st.leftOther) {
    const left = unresolvedGroups(chosen).reduce((s, g) => s + g.ops.length, 0);
    if (left && !confirm(`${left} нераспознанных операций попадут в категорию «Другое». Их можно будет поменять потом. Импортировать?`)) return;
  }
  const rules = await loadRules();
  let n = 0;
  for (const o of chosen) {
    await db.put('transactions', {
      id: db.newId(), createdAt: Date.now() + n, type: o.type, amount: o.amount,
      categoryId: o.categoryId, date: o.date, comment: o.description.slice(0, 120), importKey: importKey(o),
    });
    // Запоминаем: ваш выбор — всегда, автоматический — только если правила ещё нет
    const key = normalize(o.description);
    if (o.groupSet && o.bankCategory) rules[bankKey(o)] = o.categoryId; // вся категория банка
    else if (key && o.userSet) rules[key] = o.categoryId;
    else if (key && !rules[key] && !o.unrecognized) rules[key] = o.categoryId;
    n++;
  }
  await saveRules(rules);
  try { localStorage.setItem('lastImport', new Date().toISOString().slice(0, 10)); } catch { /* ничего */ }
  closeSheet($('imp-sheet'));
  toast(`Добавлено: ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'запись' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'записи' : 'записей'} ✓`, 3000);
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
    // Категория меняется только у этой операции
    if (e.target.classList.contains('imp-cat')) { o.categoryId = e.target.value; o.userSet = true; }
  });
  // ✕ — убрать операцию из списка (не добавлять)
  $('imp-list').addEventListener('click', (e) => {
    const b = e.target.closest('.imp-remove');
    if (!b) return;
    st.ops[Number(b.closest('.imp-row').dataset.i)].removed = true;
    render();
  });
  $('imp-removed').addEventListener('click', (e) => {
    if (!e.target.closest('#imp-restore')) return;
    for (const o of st.ops) o.removed = false;
    render();
  });
  $('imp-go2').addEventListener('click', doImport);

  // Блок «Не распознано»
  $('imp-unrec').addEventListener('change', async (e) => {
    const sel = e.target.closest('.unrec-select');
    if (!sel || !sel.value) return;
    const row = sel.closest('[data-group]');
    const key = row.dataset.group;
    let id = sel.value;
    if (id === '__new__') {
      id = await createCategory(key.startsWith('income') ? 'income' : 'expense');
      if (!id) { sel.value = ''; return; }
    }
    assignGroup(key, id);
    render();
  });
  $('imp-unrec').addEventListener('click', (e) => {
    if (!e.target.closest('#unrec-skip')) return;
    if (!confirm('Все нераспознанные траты попадут в категорию «Другое». Потом их можно поменять вручную. Продолжить?')) return;
    st.leftOther = true;
    render();
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

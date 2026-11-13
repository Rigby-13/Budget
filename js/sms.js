// =====================================================================
// sms.js — траты из текста SMS / уведомлений банка.
//
// Приложение не может само читать банк, но SMS можно скопировать
// (или настроить «Команды» iPhone, чтобы копировали сами) и вставить:
// «📋 Вставить из SMS» → сумма, магазин и дата распознаются, дальше
// то же окно проверки, что и при импорте выписки.
//
// Примеры, которые понимаем:
//   Сбер:    «MIR-1234 13:05 Покупка 350р PYATEROCHKA Баланс: 12 345.67р»
//   Т-Банк:  «Покупка, карта *1234. 350 RUB. PYATEROCHKA. Доступно 12345 RUB»
//   Альфа:   «Покупка 350,00 RUR Карта *1234 PYATEROCHKA Баланс 1 234,00 RUR»
//   ВТБ:     «Оплата 350р Карта*1234 PYATEROCHKA Баланс 1234.56р 13:05»
//   и вообще любой текст, где есть «сумма р/₽/руб/RUB».
// =====================================================================

import { parseAmount } from './importparse.js';
import { todayISO, now } from './utils.js';
import { $, openSheet, closeSheet, closeSheets, shake, toast } from './ui.js';
import { startImportOps } from './importer.js';

const AMOUNT = /(\d{1,3}(?:[  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:р\.?|₽|руб\.?|rub|rur)(?![a-zа-яё])/gi;
const BALANCE = /(баланс|доступно|остаток|бал\.|available|лимит)/i;
const SKIP = /(код|пароль|никому не сообщайте|не сообщайте|отклон|недостаточно|отказ)/i;
const INCOME = /(зачислен|пополнен|поступлен|возврат|перевод от|входящ|получен|кэшбэк|кешбэк|cashback|refund)/i;
// (\b в JavaScript не работает с русскими буквами — границы слов задаём явно)
const OP_WORDS = /^(оплата сбп|покупка|оплата|списание|перевод|зачисление|пополнение|снятие|выдача|возврат|поступление)(?=[\s,.:]|$)/i;
const CARD = /(?:^|[\s,.])(?:mir|visa|ecmc|mc|maestro|мир|карта|карты|картой|счета|счет|счёт|сч|card)(?=[\s*\-.,\d]|$)[-*\s.]*\d{0,4}|[*•]+\s?\d{4}|(?:mir|visa|ecmc)-?\d{4}/gi;

/** Текст одного или нескольких SMS → операции для окна проверки. */
export function parseSmsText(text) {
  const blocks = splitMessages(text);
  const ops = [];
  for (const msg of blocks) {
    const op = parseOne(msg);
    if (op) ops.push(op);
  }
  return ops;
}

/** Делим на отдельные сообщения: по пустым строкам; если в блоке
 *  несколько строк с суммами — каждая строка отдельно. */
function splitMessages(text) {
  const out = [];
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const withAmount = lines.filter((l) => new RegExp(AMOUNT.source, 'i').test(l));
    if (withAmount.length > 1) out.push(...lines);
    else if (lines.length) out.push(lines.join(' '));
  }
  return out;
}

function parseOne(raw) {
  const msg = raw.replace(/\s+/g, ' ').trim();
  if (!msg || SKIP.test(msg)) return null;
  // Суммы до слова «Баланс / Доступно / Остаток» — это и есть операция
  const cut = msg.search(BALANCE);
  const head = cut >= 0 ? msg.slice(0, cut) : msg;
  const re = new RegExp(AMOUNT.source, 'gi');
  const m = re.exec(head);
  if (!m) return null;
  const amount = parseAmount(m[1]);
  if (!amount) return null;

  const type = INCOME.test(head) ? 'income' : 'expense';
  const date = findDate(msg);
  const opWord = (head.match(/(покупка|оплата сбп|оплата|списание|перевод|зачисление|пополнение|снятие наличных|снятие|выдача наличных|возврат|поступление)/i) || [])[1] || '';

  // Магазин: текст после суммы (до «Баланс»), иначе — перед суммой
  let after = head.slice(m.index + m[0].length);
  let before = head.slice(0, m.index);
  const clean = (s) => s
    .replace(CARD, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')
    .replace(/\b\d{2}\.\d{2}(\.\d{2,4})?\b/g, ' ')
    .replace(OP_WORDS, ' ')
    .replace(/[,.:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let merchant = clean(after);
  if (!merchant || merchant.length < 2) merchant = clean(before).replace(OP_WORDS, '').trim();
  const opNice = opWord ? opWord[0].toUpperCase() + opWord.slice(1).toLowerCase() : '';
  return {
    date, type, amount: Math.abs(amount),
    description: (merchant || opNice || 'Операция по SMS').slice(0, 80),
    // «Перевод» / «Зачисление» помогают подобрать категорию; «Покупка» — нет
    bankCategory: /перевод|зачисл|пополн|снятие|выдача/i.test(opWord) ? opNice : '',
  };
}

/** Дата из текста (дд.мм или дд.мм.гг); нет — сегодня. */
function findDate(msg) {
  const m = msg.match(/\b(\d{2})\.(\d{2})(?:\.(\d{2,4}))?\b/);
  if (!m) return todayISO();
  const n = now();
  let y = m[3] ? Number(m[3]) : n.getFullYear();
  if (y < 100) y += 2000;
  const iso = `${y}-${m[2]}-${m[1]}`;
  if (!m[3] && iso > todayISO()) return `${y - 1}-${m[2]}-${m[1]}`; // декабрьское SMS в январе
  if (Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[1]) < 1 || Number(m[1]) > 31) return todayISO();
  return iso;
}

// ---------------------------------------------------------------------
// Окна
// ---------------------------------------------------------------------
async function useText(text) {
  const ops = parseSmsText(text);
  if (!ops.length) return false;
  closeSheets();
  await startImportOps(ops, `${ops.length} SMS`, 'Текст SMS / уведомлений');
  return true;
}

/** «📋 Вставить из SMS»: берём текст из буфера; не вышло — окно для вставки. */
export async function pasteFromSms() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { /* нет доступа — вставят вручную */ }
  if (text && await useText(text)) return;
  if (text) toast('В скопированном тексте не нашёл суммы — вставьте SMS сюда', 3500);
  openSmsSheet(text);
}

export function openSmsSheet(text = '') {
  $('sms-text').value = text;
  openSheet($('sms-sheet'));
}

export function initSms() {
  $('sms-sheet').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!(await useText($('sms-text').value))) {
      shake($('sms-text'));
      toast('Не нашёл суммы. Нужен текст вида «Покупка 350р Пятёрочка»', 3500);
    }
  });
  $('tx-sms').addEventListener('click', pasteFromSms);
  $('imp-sms').addEventListener('click', () => openSmsSheet());
}

export { closeSheet };

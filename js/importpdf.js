// =====================================================================
// importpdf.js — чтение PDF-выписок.
// Текст из PDF достаём библиотекой pdf.js (Mozilla) — она лежит
// в папке vendor и работает прямо на телефоне, файл никуда не уходит.
// Библиотека загружается только когда выбрали PDF.
//
// Разбор:
//   • Сбербанк — точный разбор формата «Выписка по платёжному счёту»;
//   • остальные банки — общий вариант: строки, где есть дата и сумма.
// На выходе — операции { date, type, amount, description, bankCategory }.
// =====================================================================

import { parseDate, parseAmount } from './importparse.js';

/** Текст PDF построчно (строки собираем по высоте на странице). */
async function pdfLines(buf) {
  const pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const doc = await pdfjs.getDocument({ data: buf, isEvalSupported: false, disableFontFace: true }).promise;
  const lines = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const rows = [];
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ x, w: it.width, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      let line = '';
      let end = null;
      for (const it of r.items) {
        if (end !== null && it.x - end > 1) line += ' ';
        line += it.s;
        end = it.x + it.w;
      }
      lines.push(line.replace(/\s+/g, ' ').trim());
    }
  }
  return lines;
}

const AMOUNT = '[+−-]?\\d{1,3}(?:[\\s\\u00a0]\\d{3})*,\\d{2}';

// ---------------------------------------------------------------------
// Сбербанк
// ---------------------------------------------------------------------
// Строка 1: «09.11.2026 19:09 Перевод СБП 850,00 2 428,57»
//           (дата, время, категория, сумма [+ — пополнение], остаток)
// Строка 2: «09.11.2026 861424 Озон Банк (Ozon). Операция по счету ****4039»
//           (дата обработки, код авторизации, описание; может переноситься)
const SBER_MAIN = new RegExp(`^(\\d{2}\\.\\d{2}\\.\\d{4}) (\\d{2}:\\d{2}) (.+?) (${AMOUNT}) (${AMOUNT})$`);
const SBER_DESC = /^\d{2}\.\d{2}\.\d{4} \d{3,8} (.+)$/;
const SBER_STOP = /^(Продолжение|Выписка по|ДАТА ОПЕРАЦИИ|Дата обработки|и код авторизации|Описание операции|Сумма в валюте|операции|В валюте счёта|Дата формирования|ПАО Сбербанк|Страница)/i;

function parseSber(lines) {
  const ops = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SBER_MAIN);
    if (!m) continue;
    const [, d, , category, amountText] = m;
    let description = '';
    const dm = (lines[i + 1] || '').match(SBER_DESC);
    if (dm) {
      description = dm[1];
      // Перенос описания на следующие строки
      for (let j = i + 2; j < lines.length && j < i + 5; j++) {
        const l = lines[j];
        if (SBER_MAIN.test(l) || SBER_DESC.test(l) || SBER_STOP.test(l) || l.length > 60) break;
        if (!/[a-zа-яё]{2}|\*{2,}\d{4}/i.test(l)) break; // сноски вроде «*» — не часть описания
        description += ' ' + l;
      }
    }
    const value = parseAmount(amountText);
    if (!value) continue;
    ops.push({
      date: parseDate(d),
      type: amountText.trim().startsWith('+') ? 'income' : 'expense',
      amount: Math.abs(value),
      bankCategory: category.trim(),
      description: cleanDescription(description),
    });
  }
  return ops;
}

/** Убираем служебные хвосты: «. Операция по карте ****5826», « RUS». */
function cleanDescription(s) {
  return s
    .replace(/\.?\s*Операция по (карте|сч[её]ту)\s*\*{2,}\d{4}/gi, '')
    .replace(/\s+RUS\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------
// Общий вариант для других банков: строка с датой и суммой
// ---------------------------------------------------------------------
function parseGeneric(lines) {
  const ops = [];
  // Сумма: 1 234,56 / -1234.56 / +45 000,00 — не часть даты и не часть другого числа
  const amountRe = /(?<![\d.,])[+−-]?\d{1,3}(?:[\s\u00a0]\d{3})*[.,]\d{2}(?![\d.,])/g;
  let anySign = false;
  for (const line of lines) {
    const date = parseDate(line);
    if (!date) continue;
    // Сначала убираем даты и время, чтобы «01.10» не приняли за сумму
    const rest = line
      .replace(/\b\d{2}\.\d{2}\.\d{2,4}\b/g, ' ')
      .replace(/\b\d{2}:\d{2}(:\d{2})?\b/g, ' ');
    const amounts = rest.match(amountRe);
    if (!amounts) continue;
    // Если сумм несколько — последняя обычно остаток, берём первую
    const text = amounts[0].trim();
    const value = parseAmount(text);
    if (!value) continue;
    if (/^[+−-]/.test(text)) anySign = true;
    const description = cleanDescription(rest.replace(amountRe, ' '));
    ops.push({ date, amount: Math.abs(value), description, bankCategory: '', raw: text });
  }
  // Есть знаки: «+» — пополнение, остальное — траты. Знаков нет — всё траты.
  for (const o of ops) o.type = anySign && o.raw.startsWith('+') ? 'income' : 'expense';
  return ops;
}

/** PDF → { ops, format } */
export async function readPdf(buf) {
  let lines;
  try {
    lines = await pdfLines(buf);
  } catch (e) {
    console.error(e);
    throw new Error('Не удалось открыть PDF. Нужен интернет при первой загрузке PDF — потом будет работать и без него.');
  }
  if (!lines.join('').trim()) throw new Error('В этом PDF нет текста (похоже на скан) — такой файл прочитать не получится');
  const text = lines.join('\n');
  if (/сбер/i.test(text) && /Расшифровка операций/i.test(text)) {
    const ops = parseSber(lines);
    if (ops.length) return { ops, format: 'PDF · Сбербанк' };
  }
  const ops = parseGeneric(lines);
  if (!ops.length) throw new Error('Не нашёл в PDF операций. Пришлите пример разработчику — добавим формат вашего банка.');
  return { ops, format: 'PDF · общий формат (проверьте операции)' };
}

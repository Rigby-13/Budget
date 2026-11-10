// =====================================================================
// importparse.js — чтение выписки из банка: CSV и Excel (.xlsx).
// Без внешних библиотек: CSV разбираем сами, XLSX — это zip-архив
// с XML-файлами внутри; распаковываем встроенным DecompressionStream.
// На выходе — таблица строк (массив массивов текста).
// =====================================================================

/** Прочитать файл → { rows: string[][], format: 'CSV' | 'Excel' } */
export async function readTable(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  // Zip-архив начинается с «PK»
  if (buf[0] === 0x50 && buf[1] === 0x4b) return { rows: await readXlsx(buf), format: 'Excel' };
  if (name.endsWith('.xls')) throw new Error('Старый формат .xls не поддерживается — сохраните выписку как .xlsx или .csv');
  if (name.endsWith('.pdf') || (buf[0] === 0x25 && buf[1] === 0x50)) throw new Error('PDF не поддерживается — выберите в банке выгрузку в Excel или CSV');
  return { rows: parseCsv(decodeText(buf)), format: 'CSV' };
}

// ---------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------
/** Текст: сначала пробуем UTF-8, если не вышло — Windows-1251 (так выгружают многие банки). */
function decodeText(buf) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1251').decode(buf);
  }
  return text.replace(/^﻿/, '');
}

/** Разбор CSV с кавычками; разделитель (; , или табуляция) определяем сами. */
export function parseCsv(text) {
  const firstLines = text.split(/\r?\n/).slice(0, 10).join('\n');
  const count = (ch) => (firstLines.match(new RegExp(ch === '\t' ? '\t' : `\\${ch}`, 'g')) || []).length;
  const sep = [';', ',', '\t'].sort((a, b) => count(b) - count(a))[0];

  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

// ---------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Распаковать нужные файлы из zip-архива. */
async function unzip(buf, wanted) {
  // Конец центрального каталога ищем с конца файла
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Файл повреждён или это не Excel');
  const total = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16);
  const out = {};
  for (let n = 0; n < total; n++) {
    if (u32(buf, p) !== 0x02014b50) break;
    const method = u16(buf, p + 10);
    const size = u32(buf, p + 20);
    const nameLen = u16(buf, p + 28), extraLen = u16(buf, p + 30), commentLen = u16(buf, p + 32);
    const local = u32(buf, p + 42);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + u16(buf, local + 26) + u16(buf, local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out[name] = data;
    else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      out[name] = new Uint8Array(await new Response(stream).arrayBuffer());
    }
  }
  return out;
}

const xml = (bytes) => new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
const byTag = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];

async function readXlsx(buf) {
  const files = await unzip(buf, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d*\.xml$/.test(n));
  const strings = files['xl/sharedStrings.xml']
    ? byTag(xml(files['xl/sharedStrings.xml']), 'si').map((si) => byTag(si, 't').map((t) => t.textContent).join(''))
    : [];
  const sheetName = Object.keys(files).filter((n) => n.includes('worksheets')).sort()[0];
  if (!sheetName) throw new Error('В файле нет листов с данными');
  const doc = xml(files[sheetName]);
  const rows = [];
  for (const r of byTag(doc, 'row')) {
    const row = [];
    for (const c of byTag(r, 'c')) {
      const ref = c.getAttribute('r') || '';
      const letters = ref.replace(/\d+/g, '');
      let col = 0;
      for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
      const t = c.getAttribute('t');
      const v = byTag(c, 'v')[0]?.textContent ?? '';
      let value = v;
      if (t === 's') value = strings[Number(v)] ?? '';
      else if (t === 'inlineStr') value = byTag(c, 't').map((x) => x.textContent).join('');
      row[(col || row.length + 1) - 1] = String(value).trim();
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
    if (row.some((x) => x !== '')) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------
// Даты и суммы
// ---------------------------------------------------------------------
/** «31.10.2026 12:30», «31.10.26», «2026-10-31», число Excel → 'ГГГГ-ММ-ДД' или null. */
export function parseDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return iso(y, Number(m[2]), Number(m[1]));
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  // Excel хранит даты числом дней с 30.12.1899
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    if (n > 30000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
  }
  return null;
}
function iso(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** «−1 234,56 ₽», «-1234.56» → копейки (со знаком) или null. */
export function parseAmount(s) {
  let t = String(s || '').replace(/[\s  ]/g, '').replace(/[−–—]/g, '-').replace(/[^\d,.\-+]/g, '');
  if (!t || !/\d/.test(t)) return null;
  // Если есть и точка, и запятая — разделитель дробной части тот, что правее
  if (t.includes(',') && t.includes('.')) {
    t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else t = t.replace(',', '.');
  const v = Number(t);
  return Number.isFinite(v) ? Math.round(v * 100) : null;
}

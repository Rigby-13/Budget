// =====================================================================
// wallet.js — «Мои деньги»: сколько денег сейчас есть.
//
// Приложение не связано с банком, поэтому один раз вы указываете
// остаток (все карты и наличные вместе, без копилки). Дальше он
// считается сам:
//   остаток + доходы − траты − отложено в копилку + взято из копилки.
// Учитываются записи, сделанные ПОСЛЕ того, как указали остаток.
// Если цифра разошлась с реальностью — просто укажите её заново.
//
// В таблице settings: { id: 'wallet', amount, date: 'ГГГГ-ММ-ДД', ts }
// =====================================================================

import * as db from './db.js';
import { formatMoney, parseMoney, moneyToInput, todayISO } from './utils.js';
import { $, openSheet, closeSheet, shake, toast, focusField } from './ui.js';

export async function getWallet() {
  return db.get('settings', 'wallet');
}

/** Запись появилась после того, как указали остаток? */
function isAfter(item, w) {
  return item.date > w.date || (item.date === w.date && (item.createdAt || 0) > w.ts);
}

/** { balance, savings } — деньги на руках и в копилке. balance = null, если остаток не указан. */
export async function getBalances() {
  const savingsAll = await db.getAll('savings');
  const savings = savingsAll.reduce((s, e) => s + e.amount, 0);
  const w = await getWallet();
  if (!w) return { balance: null, savings };
  let balance = w.amount;
  for (const t of await db.getAll('transactions')) {
    if (!isAfter(t, w)) continue;
    balance += t.type === 'income' ? t.amount : -t.amount;
  }
  for (const e of savingsAll) {
    if (isAfter(e, w)) balance -= e.amount; // отложил — денег на руках меньше
  }
  return { balance, savings };
}

export async function renderBalance() {
  const { balance, savings } = await getBalances();
  const card = $('balance-card');
  if (balance === null) {
    card.innerHTML = `<span class="hero-label">Мои деньги</span>
      <span class="balance-cta">Сколько у вас сейчас денег? Указать →</span>`;
    return;
  }
  card.innerHTML = `<span class="hero-label">Мои деньги</span>
    <span class="balance-amount ${balance < 0 ? 'negative' : ''}">${formatMoney(balance)}</span>
    ${savings ? `<span class="balance-sub">🐷 в копилке ${formatMoney(savings)}</span>` : ''}`;
}

export async function openWalletSheet() {
  const { balance } = await getBalances();
  $('wallet-amount').value = balance !== null ? moneyToInput(balance) : '';
  openSheet($('wallet-sheet'));
  focusField($('wallet-amount'));
}

async function saveWallet(e) {
  e.preventDefault();
  const text = $('wallet-amount').value.trim().replace(/^−/, '-');
  const neg = text.startsWith('-');
  const amount = parseMoney(neg ? text.slice(1) : text);
  if (!(amount >= 0)) { shake($('wallet-amount')); return; }
  await db.put('settings', { id: 'wallet', amount: neg ? -amount : amount, date: todayISO(), ts: Date.now() });
  closeSheet($('wallet-sheet'));
  toast('Остаток сохранён — дальше он будет считаться сам');
  document.dispatchEvent(new Event('wallet-changed'));
}

export function initWallet() {
  $('balance-card').addEventListener('click', openWalletSheet);
  $('wallet-sheet').addEventListener('submit', saveWallet);
}

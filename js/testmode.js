// =====================================================================
// testmode.js — тестовый режим, чтобы проверить план и лимиты сразу,
// не дожидаясь конца месяца.
//
//  • Отдельная база данных: настоящие записи не трогаются.
//  • «Машина времени»: можно перематывать дни вперёд и назад.
//  • «Заполнить примером»: план 20 000 ₽, копилка 5 000 ₽, лимиты
//    и случайные траты с начала месяца по вчерашний день.
// =====================================================================

import * as db from './db.js';
import { isTestMode, todayISO, addDays, shortDate, now } from './utils.js';
import { $, toast } from './ui.js';
import { currentMonthKey, monthBounds, savePlan } from './plan.js';

function setLS(key, value) {
  try {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch { /* ничего */ }
}

/** Перемотать «сегодня» и перезапустить приложение. */
function travelTo(iso) {
  setLS('fakeToday', iso);
  location.reload();
}

function firstOfNextMonth() {
  const d = now();
  return `${d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear()}-${String((d.getMonth() + 1) % 12 + 1).padStart(2, '0')}-01`;
}

function renderBar() {
  document.body.classList.add('test-mode');
  document.body.insertAdjacentHTML('afterbegin', `
    <div id="test-bar">
      <span class="test-date">🧪 ${shortDate(todayISO())}</span>
      <button type="button" data-travel="-1" aria-label="Предыдущий день">◀ день</button>
      <button type="button" data-travel="1" aria-label="Следующий день">день ▶</button>
      <button type="button" data-travel="month" aria-label="К первому числу следующего месяца">1-е ⏭</button>
    </div>`);
  $('test-bar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-travel]');
    if (!b) return;
    const t = b.dataset.travel;
    travelTo(t === 'month' ? firstOfNextMonth() : addDays(todayISO(), Number(t)));
  });
}

function renderControls() {
  const box = $('test-controls');
  if (!isTestMode()) {
    box.innerHTML = `
      <p class="small muted" style="margin-top:0">Отдельная пробная база и «машина времени»:
      можно перематывать дни и сразу увидеть, как работают перенос лимитов и итоги месяца.
      Ваши настоящие записи не изменятся.</p>
      <button type="button" class="secondary-btn full" id="test-on">Включить тестовый режим</button>`;
    $('test-on').addEventListener('click', () => {
      setLS('testMode', '1');
      setLS('fakeToday', todayISO());
      location.reload();
    });
    return;
  }
  box.innerHTML = `
    <p class="small" style="margin-top:0">🧪 Сейчас включён тестовый режим. Дата: <b>${shortDate(todayISO())}</b>.
    Листайте дни кнопками вверху экрана.</p>
    <button type="button" class="primary-btn full" id="test-fill">Заполнить примером</button>
    <p class="small muted">План 20 000 ₽, копилка 5 000 ₽, транспорт и нейросети по 2 000 ₽ в месяц,
    еда 2 100 ₽ в неделю (300 ₽ в день) и случайные траты с 1-го числа по вчера.</p>
    <button type="button" class="secondary-btn full" id="test-today">Вернуть сегодняшнюю дату</button>
    <button type="button" class="secondary-btn full" id="test-clear">Очистить тестовые данные</button>
    <button type="button" class="plain-btn full" id="test-off">Выключить тестовый режим</button>`;
  $('test-fill').addEventListener('click', fillExample);
  $('test-today').addEventListener('click', () => travelTo(realToday()));
  $('test-clear').addEventListener('click', async () => {
    if (!confirm('Удалить все тестовые данные?')) return;
    await db.importAll({});
    location.reload();
  });
  $('test-off').addEventListener('click', () => {
    setLS('testMode', null);
    setLS('fakeToday', null);
    location.reload();
  });
}

function realToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Пример из описания: план + случайные траты с начала месяца по вчера. */
async function fillExample() {
  // Нужные категории: берём существующие или создаём
  const cats = await db.getAll('categories');
  let order = cats.length;
  const ensure = async (name, emoji) => {
    let c = cats.find((x) => x.type === 'expense' && x.name === name && !x.archived);
    if (!c) {
      c = { id: db.newId(), type: 'expense', name, emoji, order: order++, archived: false };
      await db.put('categories', c);
    }
    return c;
  };
  const food = await ensure('Еда', '🍔');
  const transport = await ensure('Транспорт', '🚌');
  const ai = await ensure('Нейросети', '🤖');
  const fun = await ensure('Развлечения', '🎉');

  const key = currentMonthKey();
  const { from } = monthBounds(key);
  await savePlan({
    id: 'plan:' + key, month: key, income: 2000000, savings: 500000,
    limits: [
      { categoryId: transport.id, period: 'month', amount: 200000, since: from },
      { categoryId: ai.id, period: 'month', amount: 200000, since: from },
      { categoryId: food.id, period: 'week', amount: 210000, since: from },
    ],
  });

  // Случайные траты по вчерашний день
  const today = todayISO();
  const add = (categoryId, rub, date, comment = '') => db.put('transactions', {
    id: db.newId(), createdAt: Date.now(), type: 'expense', amount: Math.round(rub) * 100, categoryId, date, comment,
  });
  let n = 0;
  for (let d = from; d < today; d = addDays(d, 1)) {
    await add(food.id, 150 + Math.random() * 300, d, 'тест'); n++;
    if (Math.random() < 0.3) { await add(transport.id, 60 + Math.random() * 140, d, 'тест'); n++; }
    if (Math.random() < 0.15) { await add(fun.id, 300 + Math.random() * 900, d, 'тест'); n++; }
  }
  if (from < today) { await add(ai.id, 2000, from, 'подписка'); n++; }
  toast(`Пример готов: план и ${n} трат`);
  setTimeout(() => location.reload(), 900);
}

export function initTestMode() {
  if (isTestMode()) renderBar();
  renderControls();
}

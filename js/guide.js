// =====================================================================
// guide.js — пошаговый тур по интерфейсу.
// Затемняем экран, подсвечиваем нужную кнопку или карточку и рядом
// объясняем, что это. «Далее» / «Назад», можно пропустить.
// Показывается один раз; заново — «Ещё» → «Как пользоваться».
// =====================================================================

import { $, closeSheets } from './ui.js';
import { openWalletSheet, getWallet } from './wallet.js';

const KEY = 'tourDone';
const tab = (name) => document.querySelector(`.tab[data-view=${name}]`).click();
const openPlus = () => {
  $('fab').click();
  // Тур — не время для клавиатуры: убираем курсор из поля суммы
  setTimeout(() => document.activeElement?.blur(), 50);
  setTimeout(() => document.activeElement?.blur(), 400);
};

/**
 * Шаги тура.
 *  view   — какую вкладку открыть
 *  sel    — что подсветить (нет — подсказка по центру)
 *  before — что сделать перед шагом (например, открыть «+»)
 */
const STEPS = [
  {
    view: 'expenses', title: 'Привет! 👋',
    text: 'Покажу, как всё устроено — это займёт минуту. Данные хранятся только на этом телефоне и работают без интернета.',
  },
  {
    view: 'expenses', sel: '#balance-card', title: 'Мои деньги',
    text: 'Нажмите сюда и укажите, сколько у вас денег сейчас — все карты и наличные вместе. Дальше остаток считается сам: + доходы, − траты.',
  },
  {
    view: 'expenses', sel: '#fab', title: 'Купил — сразу записал',
    text: 'Главная кнопка. Нажимайте «+» сразу после покупки — так ничего не забудется.',
  },
  {
    view: 'expenses', before: openPlus, sel: '#amount-wrap', title: 'Сумма',
    text: 'Введите, сколько потратили. Сверху можно переключить «Расход» и «Доход».',
  },
  {
    view: 'expenses', sel: '#tx-categories', title: 'Категория',
    text: 'Выберите категорию и нажмите «Готово». Ошиблись — во всплывающем сообщении будет «Отменить».',
  },
  {
    view: 'expenses', sel: '#tx-date-chips', title: 'Трата была вчера?',
    text: 'Выберите «Вчера» или любой другой день. Комментарий — ниже, если нужен.',
  },
  {
    view: 'expenses', sel: '#tx-sms', title: 'Из SMS банка',
    text: 'Скопируйте SMS о покупке и нажмите сюда — сумма, магазин и дата распознаются сами. Можно сразу несколько сообщений.',
  },
  {
    view: 'expenses', before: closeSheets, sel: '.month-pick', title: 'Месяц и день',
    text: 'Стрелки — другой месяц. Нажмите на название — можно выбрать любой день и записать трату задним числом.',
  },
  {
    view: 'expenses', sel: '#today-hero', title: 'Сколько можно сегодня',
    text: 'Здесь главное число дня. Его дают цели «в день» из вкладки «План»: не потратили всё — остаток прибавится завтра, потратили больше — вычтется.',
  },
  {
    view: 'plan', sel: '#bud-top', title: 'План: деньги по категориям',
    text: '«Готово к распределению» — деньги, у которых ещё нет задачи. Разложите их по категориям, пока здесь не станет 0 ₽: тогда у каждого рубля есть дело.',
  },
  {
    view: 'plan', sel: '.bud-row', title: 'Нажмите на категорию',
    text: 'Назначьте ей сумму на месяц и поставьте цель: «300 ₽ в день», «2 000 ₽ в месяц» или «накопить 60 000 ₽ к июню».',
  },
  {
    view: 'plan', sel: '.bud-row .bud-pill', title: 'Сколько осталось',
    text: 'Зелёный — всё хорошо, жёлтый — до цели не хватает, красный — перерасход, серый — ноль. Остаток сам переходит на следующий месяц.',
  },
  {
    view: 'plan', sel: '[data-bud=assign]', title: 'Распределить одной кнопкой',
    text: 'Разложит деньги по целям, как в прошлом месяце или по тому, сколько вы тогда потратили. Не понравилось — «Отменить».',
    // «Мои деньги» ещё не указаны — вместо «Распределить» кнопка «Указать»
    alt: {
      sel: '[data-bud=wallet]', title: 'Сначала — сколько у вас денег',
      text: 'План распределяет только те деньги, что уже есть. Укажите их здесь — и появится кнопка «Распределить»: разложит деньги по целям или как в прошлом месяце.',
    },
  },
  {
    view: 'plan', sel: '.bud-ghead', title: 'Группы',
    text: 'Категории разложены по группам: обязательное, повседневное, цели. Нажмите на название группы — переименовать или переставить. Если категория уйдёт в минус, здесь появится кнопка «Покрыть» — возьмёте деньги из другой.',
  },
  {
    view: 'stats', sel: '#stats-section', title: 'Статистика и копилка',
    text: 'Куда уходят деньги: по категориям, по месяцам и итоги плана. «Накопления» — ваша копилка.',
  },
  {
    view: 'settings', sel: '#imp-card', important: true, title: 'Выписка из банка',
    text: 'Чтобы не вводить всё вручную, раз в несколько дней загружайте выписку из приложения банка (PDF, Excel или CSV). Категории подберутся сами, повторы пропустятся.',
  },
  {
    view: 'settings', sel: '#rec-card', title: 'Регулярные платежи',
    text: 'Подписки, связь, проездной — внесите один раз, дальше приложение само запишет их в нужный день.',
  },
  {
    view: 'settings', sel: '#open-debts', title: 'Долги и всё остальное',
    text: 'Во вкладке «Ещё» — долги, оформление (темы), категории, напоминания и резервная копия.',
  },
  {
    view: 'settings', sel: '#settings-guide', title: 'Тур можно повторить',
    text: 'Если что-то забудется — нажмите «Как пользоваться», и я покажу всё заново.',
  },
  {
    view: 'expenses', title: 'Готово! 🎉', final: true,
    text: 'Начните с главного: укажите, сколько у вас сейчас денег, потом откройте «План» и разложите их по категориям.',
  },
];

let index = 0;
let shown = [];

/** Элемент виден на экране (есть и не скрыт)? */
function visible(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

/** Шаг с учётом запасного варианта (alt), если основного элемента нет. */
function stepNow() {
  const s = STEPS[index];
  if (s.alt && s.sel && !visible(s.sel) && visible(s.alt.sel)) return { ...s, ...s.alt };
  return s;
}

function render() {
  const s = stepNow();
  const box = $('tour');
  const total = STEPS.length;
  const el = s.sel ? visible(s.sel) : null;

  const bubble = $('tour-bubble');
  bubble.classList.toggle('important', !!s.important);
  bubble.innerHTML = `
    <div class="tour-top">
      <span class="tour-count">${index + 1} из ${total}</span>
      ${s.final ? '' : '<button type="button" class="tour-skip" data-tour="skip">Пропустить</button>'}
    </div>
    ${s.important ? '<div class="tour-badge">❗ ВАЖНО</div>' : ''}
    <b class="tour-title">${s.title}</b>
    <p class="tour-text">${s.text}</p>
    <div class="tour-btns">
      ${index > 0 && !s.final ? '<button type="button" class="secondary-btn" data-tour="back">Назад</button>' : ''}
      ${s.final
        ? `${s.noWallet ? '<button type="button" class="secondary-btn" data-tour="done">Позже</button><button type="button" class="primary-btn" data-tour="wallet">Указать деньги</button>' : '<button type="button" class="primary-btn" data-tour="done">Начать</button>'}`
        : `<button type="button" class="primary-btn" data-tour="next">${index === 0 ? 'Начать' : 'Далее'}</button>`}
    </div>`;

  const hole = $('tour-hole');
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!el) {
    // Подсказка по центру, без подсветки
    hole.classList.add('none');
    hole.style.cssText = `left:${vw / 2}px;top:${vh / 2}px;width:0;height:0`;
    bubble.style.left = '16px';
    bubble.style.right = '16px';
    bubble.style.top = `${Math.max(16, vh / 2 - bubble.offsetHeight / 2)}px`;
    box.classList.add('centered');
    return;
  }
  box.classList.remove('centered');
  hole.classList.remove('none');
  const r = el.getBoundingClientRect();
  const pad = 6;
  const round = getComputedStyle(el).borderRadius;
  const top = Math.max(4, r.top - pad);
  const bottom = Math.min(vh - 4, r.bottom + pad);
  hole.style.cssText = `left:${r.left - pad}px;top:${top}px;width:${r.width + pad * 2}px;height:${bottom - top}px;border-radius:${round === '0px' ? '12px' : round}`;

  // Подсказка — под элементом, если помещается, иначе над ним
  bubble.style.left = '16px';
  bubble.style.right = '16px';
  const h = bubble.offsetHeight;
  let y = bottom + 12;
  if (y + h > vh - 12) y = top - 12 - h;
  if (y < 12) y = Math.max(12, vh - h - 12); // огромный элемент — подсказка внизу экрана
  bubble.style.top = `${y}px`;
}

async function show(i, dir = 1) {
  index = i;
  const s = STEPS[index];
  if (s.final) s.noWallet = !(await getWallet());
  const active = document.querySelector('.view.active');
  if (!active || active.id !== 'view-' + s.view) tab(s.view);
  if (s.before) s.before();
  await wait(s.before ? 380 : 120);
  const sel = stepNow().sel;
  if (sel) {
    const el = visible(sel);
    if (!el) { // нет на экране (например, «Сегодня можно» без целей) — пропускаем
      const next = index + dir;
      if (next >= 0 && next < STEPS.length) return show(next, dir);
    } else {
      // Высокий элемент — к верху экрана, чтобы подсказка поместилась под ним
      const tall = el.getBoundingClientRect().height > window.innerHeight * 0.35;
      el.scrollIntoView({ block: tall ? 'start' : 'center' });
      await wait(160);
    }
  }
  shown.push(index);
  render();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startTour() {
  closeSheets();
  $('tour').hidden = false;
  requestAnimationFrame(() => $('tour').classList.add('open'));
  shown = [];
  await show(0);
}

function endTour() {
  try { localStorage.setItem(KEY, '1'); localStorage.setItem('guideDone', '1'); } catch { /* ничего */ }
  $('tour').classList.remove('open');
  setTimeout(() => { $('tour').hidden = true; }, 200);
  closeSheets();
  tab('expenses');
  $('view-expenses').scrollTo(0, 0);
}

export function initGuide() {
  $('tour').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tour]');
    if (!b) return;
    const act = b.dataset.tour;
    if (act === 'next') show(index + 1, 1);
    if (act === 'back') {
      // Назад — на предыдущий показанный шаг (с учётом пропущенных)
      shown.pop();
      const prev = shown.pop();
      show(prev ?? 0, -1);
    }
    if (act === 'skip' || act === 'done') endTour();
    if (act === 'wallet') { endTour(); setTimeout(openWalletSheet, 250); }
  });
  window.addEventListener('resize', () => { if (!$('tour').hidden) render(); });
  $('settings-guide').addEventListener('click', startTour);

  let done = false;
  try { done = localStorage.getItem(KEY) === '1'; } catch { done = true; }
  if (!done) setTimeout(startTour, 500);
}

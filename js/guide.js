// =====================================================================
// guide.js — гайд при первом открытии: с чего начать и как пользоваться.
// Карточки листаются свайпом или кнопкой «Далее», есть «Пропустить».
// Показывается один раз; заново — Настройки → «Как пользоваться».
// =====================================================================

import { $ } from './ui.js';
import { openWalletSheet } from './wallet.js';

const SLIDES = [
  {
    emoji: '💸',
    title: 'Привет!',
    text: 'Это приложение помогает понять главное: <b>сколько можно потратить сегодня</b>, чтобы уложиться в бюджет.',
    note: 'Все данные хранятся только на этом телефоне и работают без интернета.',
  },
  {
    emoji: '💰',
    title: 'Укажите свои деньги',
    text: 'Нажмите на карточку <b>«Мои деньги»</b> на главном экране и введите, сколько у вас сейчас: все карты и наличные вместе, без копилки.',
    mock: `<div class="g-mock"><span class="muted small">Мои деньги</span><b class="g-big">21 500 ₽</b><span class="muted small">🐷 в копилке 3 000 ₽</span></div>`,
    note: 'Дальше остаток считается сам: + доходы, − траты.',
  },
  {
    emoji: '📋',
    title: 'Составьте план',
    text: 'Нажмите <b>«+» → «Лимит»</b>. Задайте 💰 бюджет на месяц, сколько отложить в копилку, и лимиты по категориям — в день, неделю или месяц.',
    mock: `<div class="g-mock small">20 000 ₽ − 5 000 ₽ в копилку − лимиты = <b>свободно</b><br>🍔 Еда: 2 100 ₽ в неделю = <b>300 ₽ в день</b></div>`,
    note: 'План сохраняется и сам переходит на следующий месяц. Можно завести несколько планов.',
  },
  {
    emoji: '⚡',
    title: 'Купил — сразу записал',
    text: 'Нажмите <b>«+»</b> или карточку <b>«Сегодня можно»</b>, введите сумму и «Готово». Ошиблись — нажмите «Отменить» в сообщении.',
    mock: `<div class="g-mock"><span class="muted small">Сегодня можно</span><b class="g-big">250 ₽</b><span class="progress big limit-bar ok"><i style="width:40%"></i></span><span class="muted small">🍔 Еда · 300 ₽ в день</span></div>`,
  },
  {
    emoji: '🔁',
    title: 'Остаток переходит на завтра',
    text: 'Не потратили весь дневной лимит — разница <b>прибавится завтра</b>. Потратили больше — <b>вычтется</b> из завтрашнего.',
    note: '1-го числа вы увидите итоги месяца: сколько сэкономили и сколько превысили, — и одним нажатием отложите деньги в копилку.',
  },
  {
    emoji: '📊',
    title: 'Статистика и накопления',
    text: 'Во вкладке <b>«Статистика»</b> — траты по категориям, по месяцам и план. Переключатель <b>«Накопления»</b> — ваша копилка и итоги месяцев.',
    note: 'Во вкладке «Долги» — кто кому сколько должен.',
  },
  {
    emoji: '🛟',
    title: 'Чтобы ничего не потерять',
    text: 'Время от времени сохраняйте копию: <b>Настройки → «Сохранить копию в файл»</b>. Если удалить приложение, данные удалятся вместе с ним.',
    note: 'Хотите попробовать без риска? Включите «Тестовый режим» в настройках — там отдельные данные и можно перематывать дни.',
    last: true,
  },
];

let index = 0;

function markDone() {
  try { localStorage.setItem('guideDone', '1'); } catch { /* ничего */ }
}
function isDone() {
  try { return localStorage.getItem('guideDone') === '1'; } catch { return true; }
}

function render() {
  $('guide-track').innerHTML = SLIDES.map((s) => `
    <section class="g-slide">
      <div class="g-emoji">${s.emoji}</div>
      <h2>${s.title}</h2>
      <p class="g-text">${s.text}</p>
      ${s.mock || ''}
      ${s.note ? `<p class="g-note">${s.note}</p>` : ''}
    </section>`).join('');
  $('guide-dots').innerHTML = SLIDES.map((_, i) => `<i data-i="${i}"></i>`).join('');
  update();
}

function update() {
  const last = index === SLIDES.length - 1;
  for (const d of $('guide-dots').children) d.classList.toggle('active', Number(d.dataset.i) === index);
  $('guide-next').textContent = last ? 'Начать' : 'Далее';
  $('guide-wallet').hidden = !last;
  $('guide-skip').style.visibility = last ? 'hidden' : 'visible';
}

function goTo(i) {
  const track = $('guide-track');
  track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' });
}

export function openGuide() {
  index = 0;
  render();
  $('guide').hidden = false;
  requestAnimationFrame(() => {
    $('guide-track').scrollLeft = 0;
    $('guide').classList.add('open');
  });
}

function closeGuide() {
  markDone();
  $('guide').classList.remove('open');
  setTimeout(() => { $('guide').hidden = true; }, 250);
}

export function initGuide() {
  const track = $('guide-track');
  // Свайп: узнаём текущую карточку по прокрутке
  track.addEventListener('scroll', () => {
    const i = Math.round(track.scrollLeft / track.clientWidth);
    if (i !== index) { index = i; update(); }
  }, { passive: true });
  $('guide-next').addEventListener('click', () => {
    if (index >= SLIDES.length - 1) closeGuide();
    else goTo(index + 1);
  });
  $('guide-skip').addEventListener('click', closeGuide);
  $('guide-wallet').addEventListener('click', () => { closeGuide(); openWalletSheet(); });
  $('guide-dots').addEventListener('click', (e) => {
    const d = e.target.closest('[data-i]');
    if (d) goTo(Number(d.dataset.i));
  });
  $('settings-guide').addEventListener('click', openGuide);

  if (!isDone()) openGuide();
}

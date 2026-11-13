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
    text: 'Вкладка <b>«План»</b>: распределите деньги, которые у вас есть, по категориям. Остаток категории переходит на следующий месяц.',
    mock: `<div class="g-mock small">Готово к распределению <b>2 300 ₽</b><br>🍔 Еда: цель <b>300 ₽ в день</b></div>`,
    note: 'Цель «в день» даёт «Сегодня можно» на главном экране.',
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
    text: 'Не потратили всё за день — разница <b>прибавится завтра</b>. Потратили больше — <b>вычтется</b> из завтрашнего.',
    note: '1-го числа вы увидите итоги месяца: сколько сэкономили и сколько превысили, — и одним нажатием отложите деньги в копилку.',
  },
  {
    emoji: '📊',
    title: 'Статистика и накопления',
    text: 'Во вкладке <b>«Статистика»</b> — траты по категориям, по месяцам и план. Переключатель <b>«Накопления»</b> — ваша копилка и итоги месяцев.',
    note: 'Во вкладке «Долги» — кто кому сколько должен.',
  },
  {
    emoji: '📥',
    important: true,
    title: 'Импорт выписки из банка',
    text: 'Не обязательно вводить всё вручную. Выгрузите в приложении банка <b>выписку за месяц</b> в формате <b>PDF, Excel или CSV</b> и загрузите её: <b>Настройки → «Импорт выписки»</b>.',
    mock: `<div class="g-mock small">📄 выписка_октябрь.pdf<br>Операций: <b>124</b> · расходы <b>45 300 ₽</b><br><span class="muted">категории подобраны, повторы пропущены</span></div>`,
    note: 'Категории подберутся сами, уже внесённые траты не задвоятся.',
  },
  {
    emoji: '🛟',
    title: 'Чтобы ничего не потерять',
    text: 'Время от времени сохраняйте копию: <b>Настройки → «Сохранить копию в файл»</b>. Если удалить приложение, данные удалятся вместе с ним.',
    note: 'Попробовать без риска можно в «Тестовом режиме» (Настройки).',
    alert: 'Рекомендуется добавить выписку из банка за месяц, чтобы не вводить всё вручную.',
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
    <section class="g-slide"><div class="g-inner">
      ${s.important ? '<div class="g-badge">❗ ВАЖНО</div>' : ''}
      <div class="g-emoji">${s.emoji}</div>
      <h2>${s.title}</h2>
      <p class="g-text">${s.text}</p>
      ${s.mock || ''}
      ${s.note ? `<p class="g-note">${s.note}</p>` : ''}
      ${s.alert ? `<div class="g-alert">❗ ${s.alert}</div>` : ''}
    </div></section>`).join('');
  $('guide-dots').innerHTML = SLIDES.map((_, i) => `<i data-i="${i}"></i>`).join('');
  update();
}

function update() {
  const last = index === SLIDES.length - 1;
  for (const d of $('guide-dots').children) d.classList.toggle('active', Number(d.dataset.i) === index);
  $('guide-next').textContent = last ? 'Начать' : 'Далее';
  $('guide-wallet').hidden = !last;
  $('guide-import').hidden = !last;
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
  // «Загрузить выписку» — сразу открываем выбор файла
  $('guide-import').addEventListener('click', () => {
    closeGuide();
    document.querySelector('.tab[data-view=settings]').click();
    $('imp-file-input').click();
  });
  $('guide-dots').addEventListener('click', (e) => {
    const d = e.target.closest('[data-i]');
    if (d) goTo(Number(d.dataset.i));
  });
  $('settings-guide').addEventListener('click', openGuide);

  if (!isDone()) openGuide();
}

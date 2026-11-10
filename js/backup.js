// =====================================================================
// backup.js — резервная копия: экспорт всех данных в файл JSON
// и импорт обратно.
// =====================================================================

import * as db from './db.js';
import { todayISO, shortDate } from './utils.js';
import { $, openSheet, toast } from './ui.js';

const APP_ID = 'budget-pwa';
const BACKUP_VERSION = 1;

// Файл готовим заранее, при открытии настроек: на iPhone окно
// «Поделиться» открывается, только если вызвать его сразу после нажатия.
let preparedFile = null;

async function makeFile() {
  const backup = {
    app: APP_ID,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: await db.exportAll(),
  };
  const json = JSON.stringify(backup, null, 2);
  return new File([json], `budget-backup-${todayISO()}.json`, { type: 'application/json' });
}

export async function openSettings() {
  preparedFile = null;
  renderLastBackup();
  const data = await db.exportAll();
  $('backup-stats').textContent =
    `Записей: ${data.transactions.length} · долгов: ${data.debts.length} · вещей в корзине: ${data.wishlist.length}`;
  openSheet($('settings-sheet'));
  preparedFile = await makeFile();
}

function renderLastBackup() {
  let last = null;
  try { last = localStorage.getItem('lastBackup'); } catch { /* ничего */ }
  $('backup-last').textContent = last
    ? `Последняя копия: ${shortDate(last)}`
    : 'Копию ещё ни разу не делали';
}

async function exportBackup() {
  const file = preparedFile || await makeFile();

  // Вариант 1: окно «Поделиться» (на iPhone → «Сохранить в Файлы»)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Резервная копия бюджета' });
      markBackupDone();
    } catch (e) {
      if (e.name !== 'AbortError') toast('Не удалось поделиться: ' + e.message);
    }
    return;
  }

  // Вариант 2: обычное скачивание файла (компьютер)
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  markBackupDone();
}

function markBackupDone() {
  try { localStorage.setItem('lastBackup', todayISO()); } catch { /* ничего */ }
  renderLastBackup();
  toast('Копия сохранена');
}

async function importBackup(file) {
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    toast('Это не файл резервной копии');
    return;
  }
  if (backup?.app !== APP_ID || typeof backup.data !== 'object') {
    toast('Файл не похож на копию этого приложения');
    return;
  }

  const d = backup.data;
  const when = backup.exportedAt ? shortDate(backup.exportedAt.slice(0, 10)) : '?';
  const ok = confirm(
    `Восстановить копию от ${when}?\n\n` +
    `В ней записей: ${d.transactions?.length ?? 0}, долгов: ${d.debts?.length ?? 0}.\n\n` +
    'ВСЕ текущие данные на телефоне будут заменены данными из файла.'
  );
  if (!ok) return;

  try {
    await db.importAll(d);
  } catch (e) {
    toast('Ошибка импорта: ' + e.message);
    return;
  }
  // Перезапускаем приложение, чтобы всё перечиталось из базы
  location.reload();
}

export function initBackup() {
  $('backup-export').addEventListener('click', exportBackup);
  $('backup-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // чтобы тот же файл можно было выбрать снова
    if (file) importBackup(file);
  });
}

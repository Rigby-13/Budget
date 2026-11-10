// =====================================================================
// db.js — работа с локальной базой данных IndexedDB.
// IndexedDB — это встроенная в браузер база данных. Данные лежат
// прямо на телефоне и никуда не отправляются.
// =====================================================================

const DB_NAME = 'budget-db';
const DB_VERSION = 1;

// Все "таблицы" (в IndexedDB они называются object stores).
// Создаём сразу все, которые понадобятся на следующих этапах,
// чтобы потом не мучиться с миграциями.
const STORES = [
  'transactions',   // расходы и доходы
  'categories',     // категории расходов/доходов
  'debts',          // долги (этап 3)
  'wishlist',       // вещи в корзине (этап 4)
  'wishCategories', // категории корзины (этап 4)
  'settings',       // настройки (лимиты и прочее)
];

let dbPromise = null;

/** Открывает базу (один раз) и возвращает Promise с объектом базы. */
export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    // Вызывается, когда базы ещё нет или версия выросла.
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          if (name === 'transactions') store.createIndex('date', 'date');
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Вспомогательная функция: превращает запрос IndexedDB в Promise. */
function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

/** Получить все записи из таблицы. */
export async function getAll(name) {
  return promisify((await store(name)).getAll());
}

/** Получить одну запись по id. */
export async function get(name, id) {
  return promisify((await store(name)).get(id));
}

/** Добавить или обновить запись (если id уже есть — перезапишется). */
export async function put(name, item) {
  await promisify((await store(name, 'readwrite')).put(item));
  return item;
}

/** Удалить запись по id. */
export async function remove(name, id) {
  return promisify((await store(name, 'readwrite')).delete(id));
}

/** Получить транзакции за период [from, to] (даты в виде 'ГГГГ-ММ-ДД'). */
export async function getTransactionsBetween(from, to) {
  const s = await store('transactions');
  return promisify(s.index('date').getAll(IDBKeyRange.bound(from, to)));
}

/** Уникальный id для новой записи. */
export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

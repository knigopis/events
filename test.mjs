// Проверки бота снимков: подписи, последние версии, удаления, предохранитель.
import assert from 'node:assert/strict';

import { checkFuse, fetchAll, isValid, resolve } from './snapshot.mjs';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

const alice = generateSecretKey(), bob = generateSecretKey();
const ev = (sk, kind, created_at, tags = [], content = '') => finalizeEvent({ kind, created_at, tags, content }, sk);
const ids = (list) => list.map((e) => e.id).sort();

// Подписи.
const book = ev(alice, 31110, 100, [['d', 'b1'], ['title', 'Книга']]);
assert.equal(isValid(book), true);
assert.equal(isValid({ ...book, content: 'подделка' }), false, 'изменённое содержимое');
assert.equal(isValid({ ...book, tags: [['d', 'b1'], ['title', 'Другая']] }), false, 'изменённые теги');
assert.equal(isValid(ev(alice, 1, 100)), false, 'чужой вид (заметка kind 1)');
assert.equal(isValid({ ...book, pubkey: '../../etc' }), false, 'ключ-путь');
assert.equal(isValid(null), false);

// Последняя версия по адресу; при равном времени — меньший id.
const v2 = ev(alice, 31110, 200, [['d', 'b1'], ['title', 'Книга 2']]);
const other = ev(alice, 31110, 150, [['d', 'b2'], ['title', 'Другая']]);
assert.deepEqual(ids(resolve([book, v2, other, v2])), ids([v2, other]));
const t1 = ev(alice, 31110, 300, [['d', 'b3'], ['title', 'x']]);
const t2 = ev(alice, 31110, 300, [['d', 'b3'], ['title', 'y']]);
assert.deepEqual(ids(resolve([t1, t2])), [t1.id < t2.id ? t1.id : t2.id]);
const p1 = ev(alice, 0, 10, [], '{"name":"a"}'), p2 = ev(alice, 0, 20, [], '{"name":"b"}');
assert.deepEqual(ids(resolve([p2, p1])), [p2.id]);

// Удаление, как его делает Книгопись: надгробие + kind 5 с тегом a.
const tomb = ev(alice, 31110, 400, [['d', 'b1'], ['deleted', '1']]);
const del = ev(alice, 5, 400, [['a', `31110:${tomb.pubkey}:b1`], ['k', '31110']]);
assert.deepEqual(ids(resolve([book, v2, tomb, del])), ids([tomb, del]), 'надгробие остаётся');
// Узел без надгробия, но с kind 5: старая версия выпадает.
assert.deepEqual(ids(resolve([v2, del])), ids([del]));
// Запись, созданная заново после удаления, остаётся.
const again = ev(alice, 31110, 500, [['d', 'b1'], ['title', 'Снова']]);
assert.deepEqual(ids(resolve([v2, del, again])), ids([del, again]));
// Чужой kind 5 ничего не удаляет.
const evil = ev(bob, 5, 900, [['a', `31110:${book.pubkey}:b2`], ['e', other.id]]);
assert.deepEqual(ids(resolve([other, evil])), ids([other, evil]));
// Удаление по e своего события.
const delE = ev(alice, 5, 900, [['e', other.id]]);
assert.deepEqual(ids(resolve([other, delE])), ids([delE]));

// Предохранитель.
const f = (before, after, added) => checkFuse({ before, after, added, maxNew: 5000, maxShrinkPercent: 10 });
assert.equal(f(0, 300, 300).length, 0, 'первый снимок — без проверки новых');
assert.equal(f(1000, 7000, 6000).length, 1, 'слишком много новых');
assert.equal(f(1000, 6000, 5000).length, 0, 'ровно порог — можно');
assert.equal(f(1000, 0, 0).length, 1, 'узлы пусты');
assert.equal(f(5, 0, 0).length, 1, 'узлы пусты даже при маленьком снимке');
assert.equal(f(1000, 890, 0).length, 1, 'минус 11%');
assert.equal(f(1000, 905, 0).length, 0, 'минус 9,5% — обычные удаления');
assert.equal(f(30, 21, 0).length, 0, 'минус 9 событий — мало, чтобы тревожить');
assert.equal(f(30, 20, 0).length, 1, 'минус 10 из 30');

// Недоступный узел.
await assert.rejects(fetchAll('wss://nonexistent.invalid'));
console.log('все проверки прошли');

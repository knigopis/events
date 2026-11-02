#!/usr/bin/env node
// Снимок записей Книгописи: все события со всех узлов из relays.txt →
// events/<первые 2 символа ключа>/<ключ автора>.jsonl, по событию в строке.
// В снимке — последняя версия каждой записи, прошлые версии остаются в истории git.
//
// Предохранитель: если новых событий слишком много (похоже на спам) или снимок
// резко уменьшился (узлы пусты или сломаны), снимок не пишется, а скрипт падает —
// GitHub пришлёт письмо. FORCE=1 — принять снимок всё равно.
//
// Переменные: RELAYS (вместо relays.txt), DIR (events), MAX_NEW (5000),
// MAX_SHRINK_PERCENT (10), PAGE (5000), FORCE, MESSAGE_FILE — куда записать
// сообщение коммита.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyEvent } from 'nostr-tools/pure';

// Те же виды, что принимает relay (relay/write-policy.py в коде сайта).
export const KINDS = [0, 3, 5, 10002, 31110, 31111, 31112];
const TIMEOUT = 60_000;

// --- Чтение с узла ---

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error('нет соединения')); }, TIMEOUT);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ошибка соединения')); };
  });
}

let subSeq = 0;
function req(ws, filter) {
  return new Promise((resolve, reject) => {
    const id = `snap${++subSeq}`;
    const events = [];
    const done = (err) => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
      if (err) reject(err); else resolve(events);
    };
    const timer = setTimeout(() => done(new Error('нет ответа')), TIMEOUT);
    const onClose = () => done(new Error('узел закрыл соединение'));
    const onMessage = (msg) => {
      let data;
      try { data = JSON.parse(msg.data); } catch { return; }
      if (!Array.isArray(data) || data[1] !== id) return;
      if (data[0] === 'EVENT') events.push(data[2]);
      else if (data[0] === 'EOSE') { ws.send(JSON.stringify(['CLOSE', id])); done(); }
      else if (data[0] === 'CLOSED') done(new Error(`узел отклонил запрос: ${data[2]}`));
    };
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.send(JSON.stringify(['REQ', id, filter]));
  });
}

// Все события узла, страницами от новых к старым. Узел отдаёт не больше своего
// лимита за раз (у strfry Книгописи — 5000), поэтому идём назад по until.
export async function fetchAll(url, page = 5000) {
  const ws = await connect(url);
  try {
    const got = new Map();
    let until;
    for (;;) {
      const filter = { kinds: KINDS, limit: page };
      if (until !== undefined) filter.until = until;
      const events = await req(ws, filter);
      let fresh = 0;
      let oldest = Infinity;
      for (const ev of events) {
        if (typeof ev?.created_at === 'number' && ev.created_at < oldest) oldest = ev.created_at;
        if (typeof ev?.id === 'string' && !got.has(ev.id)) { got.set(ev.id, ev); fresh++; }
      }
      if (oldest === Infinity) break;
      // Страница принесла новое — следующую берём с той же секунды: там могли остаться
      // события. Не принесла — всё за эту секунду уже есть, идём на секунду назад.
      // (Если за одну секунду событий больше лимита узла, часть потеряется; у
      // Книгописи так не бывает — перенос раскладывает записи по разным секундам.)
      const next = fresh ? oldest : oldest - 1;
      if (next < 0 || (!fresh && next === until)) break; // узел не слушает until
      until = next;
    }
    return [...got.values()];
  } finally {
    ws.close();
  }
}

// --- Сборка снимка ---

const FIELDS = ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'];
const tag = (ev, name) => ev.tags.find((t) => t[0] === name)?.[1];

// Только поля события, в постоянном порядке: одинаковое событие — одинаковая строка.
function clean(ev) {
  const out = {};
  for (const key of FIELDS) out[key] = ev[key];
  return out;
}

export function isValid(ev) {
  try {
    return (
      KINDS.includes(ev.kind) &&
      /^[0-9a-f]{64}$/.test(ev.pubkey) &&
      Array.isArray(ev.tags) &&
      verifyEvent(clean(ev))
    );
  } catch {
    return false;
  }
}

// Адрес записи: у заменяемых событий (профиль, подписки, книга…) хранится только
// последняя версия по адресу, остальные — каждое само по себе. Формат — как в теге a.
function addressOf(ev) {
  if (ev.kind === 0 || ev.kind === 3 || (ev.kind >= 10000 && ev.kind < 20000)) return `${ev.kind}:${ev.pubkey}:`;
  if (ev.kind >= 30000 && ev.kind < 40000) return `${ev.kind}:${ev.pubkey}:${tag(ev, 'd') ?? ''}`;
  return ev.id;
}

const newer = (a, b) => (a.created_at !== b.created_at ? a.created_at > b.created_at : a.id < b.id);

// Объединение событий со всех узлов → последние версии, без удалённого.
export function resolve(events) {
  const latest = new Map();
  for (const ev of events) {
    const key = addressOf(ev);
    const prev = latest.get(key);
    if (!prev || newer(ev, prev)) latest.set(key, ev);
  }
  // Удаление (kind 5) действует только на события того же автора. Книгопись при
  // удалении сначала пишет «надгробие» (та же запись с тегом deleted) — его оставляем:
  // на любом узле оно заменит старую версию, даже если узел не понимает kind 5.
  const deletedIds = new Set();
  const deletedUntil = new Map();
  for (const ev of latest.values()) {
    if (ev.kind !== 5) continue;
    for (const [name, value] of ev.tags) {
      if (name === 'e') deletedIds.add(`${ev.pubkey}:${value}`);
      if (name === 'a' && typeof value === 'string' && value.split(':')[1] === ev.pubkey) {
        deletedUntil.set(value, Math.max(deletedUntil.get(value) ?? 0, ev.created_at));
      }
    }
  }
  return [...latest.values()].filter((ev) => {
    if (ev.kind === 5) return true;
    if (deletedIds.has(`${ev.pubkey}:${ev.id}`)) return false;
    if (tag(ev, 'deleted')) return true;
    return !(deletedUntil.get(addressOf(ev)) >= ev.created_at);
  });
}

function sortKey(ev) {
  return [ev.kind, tag(ev, 'd') ?? '', ev.created_at, ev.id];
}
function compare(a, b) {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return 0;
}

// --- Файлы ---

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* walk(path);
    else if (e.name.endsWith('.jsonl')) yield path;
  }
}

export function readSnapshot(dir) {
  const ids = new Set();
  for (const path of walk(dir)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { ids.add(JSON.parse(line).id); } catch {}
    }
  }
  return ids;
}

export function writeSnapshot(dir, events) {
  const byAuthor = new Map();
  for (const ev of events) {
    if (!byAuthor.has(ev.pubkey)) byAuthor.set(ev.pubkey, []);
    byAuthor.get(ev.pubkey).push(ev);
  }
  rmSync(dir, { recursive: true, force: true });
  for (const [pubkey, list] of byAuthor) {
    const sub = join(dir, pubkey.slice(0, 2));
    mkdirSync(sub, { recursive: true });
    const lines = list.sort(compare).map((ev) => JSON.stringify(clean(ev)));
    writeFileSync(join(sub, `${pubkey}.jsonl`), lines.join('\n') + '\n');
  }
  return byAuthor.size;
}

// --- Предохранитель ---

export function checkFuse({ before, after, added, maxNew, maxShrinkPercent }) {
  const problems = [];
  if (before > 0 && added > maxNew) {
    problems.push(`новых событий ${added} — больше ${maxNew}. Похоже на спам или на массовый перенос.`);
  }
  const lost = before - after;
  if (before > 0 && (after === 0 || (lost >= 10 && lost * 100 > before * maxShrinkPercent))) {
    problems.push(`событий стало ${after} вместо ${before}. Узлы пусты, сломаны или недоступны?`);
  }
  return problems;
}

// --- Запуск ---

function relayList() {
  const src = process.env.RELAYS ?? readFileSync('relays.txt', 'utf8');
  return src
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .flatMap((line) => line.split(/[\s,]+/))
    .filter(Boolean);
}

async function main() {
  const env = process.env;
  const dir = env.DIR || 'events';
  const page = Number(env.PAGE || 5000);
  const notes = [];

  const all = [];
  let reached = 0;
  for (const url of relayList()) {
    try {
      const events = await fetchAll(url, page);
      all.push(...events);
      reached++;
      notes.push(`${url}: ${events.length} событий`);
    } catch (err) {
      notes.push(`${url}: НЕ ПРОЧИТАН — ${err.message}`);
    }
  }
  const finish = (lines, code) => {
    const text = lines.join('\n');
    console.log(text);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text.replace(/\n/g, '  \n') + '\n');
    process.exit(code);
  };
  if (!reached) finish(['Ни один узел не прочитан, снимок не записан.', ...notes], 1);

  const valid = [];
  const invalid = new Set();
  for (const ev of all) {
    if (isValid(ev)) valid.push(ev);
    else invalid.add(ev?.id);
  }
  if (invalid.size) notes.push(`отброшено событий с неверной подписью или чужого вида: ${invalid.size}`);
  const events = resolve(valid);

  const before = readSnapshot(dir);
  const after = new Set(events.map((ev) => ev.id));
  const added = [...after].filter((id) => !before.has(id)).length;
  const removed = [...before].filter((id) => !after.has(id)).length;

  const problems = checkFuse({
    before: before.size,
    after: after.size,
    added,
    maxNew: Number(env.MAX_NEW || 5000),
    maxShrinkPercent: Number(env.MAX_SHRINK_PERCENT || 10),
  });
  if (problems.length && !env.FORCE) {
    finish(
      [
        'Сработал предохранитель, снимок не записан:',
        ...problems.map((p) => `- ${p}`),
        'Если всё в порядке — Actions → snapshot → Run workflow с галочкой «force».',
        '',
        ...notes,
      ],
      1,
    );
  }

  const authors = writeSnapshot(dir, events);
  const message = [
    `Снимок: событий ${after.size}, авторов ${authors} (новых ${added}, ушло ${removed})`,
    '',
    ...(problems.length ? ['Предохранитель пропущен (force):', ...problems.map((p) => `- ${p}`), ''] : []),
    ...notes,
  ];
  if (env.MESSAGE_FILE) writeFileSync(env.MESSAGE_FILE, message.join('\n') + '\n');
  finish(message, 0);
}

// Запуск командой; при import (проверки) — только функции.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

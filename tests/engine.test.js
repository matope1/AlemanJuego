import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { words, validateWordBank } from '../src/words.js';
import { applyWordResult, calculateAnswerScore, isRoundComplete, selectWeightedWord, summarizeRound } from '../src/engine.js';
import { rankOnlinePlayers } from '../src/online.js';

test('el banco contiene 500 sustantivos únicos, bien capitalizados y equilibrados', () => {
  assert.equal(words.length, 500);
  assert.deepEqual(validateWordBank().errors, []);
  const counts = Object.fromEntries(['der','die','das'].map(article => [article, words.filter(word => word.article === article).length]));
  assert.deepEqual(counts, { der: 167, die: 166, das: 167 });
  for (const word of words) {
    assert.ok(word.translation && word.category && word.level);
    assert.ok(['A1','A2'].includes(word.level));
  }
});

test('una partida evita repetir hasta agotar el banco disponible', () => {
  const pool = words.slice(0, 3);
  const used = new Set();
  const chosen = pool.map(() => {
    const next = selectWeightedWord(pool, {}, used, 1, () => .25);
    used.add(next.id);
    return next.id;
  });
  assert.equal(new Set(chosen).size, 3);
  assert.ok(pool.some(word => selectWeightedWord(pool, {}, used, 1, () => 0).id === word.id));
});

test('las rondas finitas terminan en el tamaño elegido y práctica libre continúa', () => {
  for (const length of [10,20,30,50]) {
    assert.equal(isRoundComplete(length - 1, length), false);
    assert.equal(isRoundComplete(length, length), true);
  }
  assert.equal(isRoundComplete(5000, 0), false);
});

test('el repaso favorece errores recientes y palabras vencidas', () => {
  const pool = [{ id: 'new' }, { id: 'hard' }];
  const stats = { hard: { wrong: 8, mastery: 0, dueAt: 1, lastSeen: 1 } };
  let seed = 42;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let hardCount = 0;
  for (let i = 0; i < 1000; i++) if (selectWeightedWord(pool, stats, new Set(), 10, random).id === 'hard') hardCount++;
  assert.ok(hardCount > 850, `La palabra difícil apareció ${hardCount} veces`);
});

test('la puntuación combina acierto, rapidez y racha con un límite', () => {
  assert.equal(calculateAnswerScore(5, 1), 100);
  assert.equal(calculateAnswerScore(2, 2), 113);
  assert.equal(calculateAnswerScore(.7, 20), 155);
});

test('el historial de cada palabra actualiza dominio y fecha de repaso', () => {
  const base = { seen: 2, correct: 1, wrong: 1, mastery: 2 };
  const right = applyWordResult(base, true, 1000);
  assert.deepEqual({ seen: right.seen, correct: right.correct, wrong: right.wrong, mastery: right.mastery }, { seen: 3, correct: 2, wrong: 1, mastery: 3 });
  assert.equal(right.dueAt, 1000 + 9 * 86400000);
  const wrong = applyWordResult(base, false, 1000);
  assert.deepEqual({ seen: wrong.seen, correct: wrong.correct, wrong: wrong.wrong, mastery: wrong.mastery }, { seen: 3, correct: 1, wrong: 2, mastery: 1 });
  assert.equal(wrong.dueAt, 1000 + 300000);
});

test('el resumen calcula precisión y tiempo medio también con rondas vacías', () => {
  assert.deepEqual(summarizeRound(3, 1, [1, 3]), { total: 4, accuracy: 75, average: 2 });
  assert.deepEqual(summarizeRound(0, 0, []), { total: 0, accuracy: 0, average: 0 });
});

test('los controles que usa la interfaz existen y los botones de respuesta están completos', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const ids = new Set(allIds);
  const usedIds = [...js.matchAll(/\$\('#([^']+)'\)/g)].map(match => match[1]);
  assert.equal(ids.size, allIds.length, 'Los IDs del HTML deben ser únicos');
  assert.deepEqual([...new Set(usedIds.filter(id => !ids.has(id)))], []);
  for (const article of ['der','die','das']) assert.match(html, new RegExp(`data-article="${article}"`));
  for (const length of ['0','10','20','30','50']) assert.match(html, new RegExp(`data-length="${length}"`));
});

test('la clasificación multijugador admite varios ganadores por empate', () => {
  const { ordered, winners, winningScore } = rankOnlinePlayers([
    { display_name: 'Ada', score: 250 },
    { display_name: 'Luz', score: 310 },
    { display_name: 'Sam', score: 310 },
    { display_name: 'Noa', score: 100 }
  ]);
  assert.equal(ordered[0].display_name, 'Luz');
  assert.equal(winningScore, 310);
  assert.deepEqual(winners.map(player => player.display_name), ['Luz','Sam']);
});

test('la migración mantiene respuestas y artículos correctos fuera del acceso directo', async () => {
  const sql = await readFile(new URL('../supabase/migrations/202611240001_brava_multiplayer.sql', import.meta.url), 'utf8');
  for (const table of ['brava_words','brava_rooms','brava_players','brava_room_questions','brava_answers']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  }
  assert.match(sql, /revoke all on public\.brava_words, public\.brava_rooms, public\.brava_players,\s*public\.brava_room_questions, public\.brava_answers from anon, authenticated/i);
  assert.match(sql, /primary key \(room_id, question_no, user_id\)/i);
  assert.match(sql, /case when r\.phase in \('reveal','finished'\) then w\.article else null end/i);
  assert.doesNotMatch(sql, /return public\.brava_room_state\(r\.code\)/i, 'Las RPC de avance no deben recursar el cálculo del estado');
  assert.match(sql, /v_correct := p_article = v_word\.article/i);
  assert.match(sql, /v_points := 100/i);
});

test('el seed de Supabase contiene una fila por cada palabra y la vista conserva viewport móvil', async () => {
  const seed = await readFile(new URL('../supabase/seed.sql', import.meta.url), 'utf8');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const ids = [...seed.matchAll(/^\('(der|die|das)-([\w-]+)'/gm)].map(match => `${match[1]}-${match[2]}`);
  assert.equal(ids.length, 500);
  assert.equal(new Set(ids).size, 500);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1/);
  assert.match(css, /@media\(max-width:700px\)/);
  assert.match(css, /\.online-answer-buttons \.answer-button\{[^}]*min-height:78px/);
});

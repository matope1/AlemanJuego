import { words, validateWordBank } from './words.js';
import { applyWordResult, calculateAnswerScore, isRoundComplete, selectWeightedWord, summarizeRound } from './engine.js';
import { OnlineRoomController } from './online.js';

const STORAGE_KEY = 'deutsch-brava-v1';
const blankState = () => ({ profile: 'Lena', stats: {}, games: [], totalScore: 0, bestStreak: 0, daily: { date: '', streak: 0 } });
const readState = () => { try { return { ...blankState(), ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; } catch { return blankState(); } };
let state = readState();
let game = null;
let timer = null;
let toastTimer = null;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function statsFor(id) { return state.stats[id] ||= { seen: 0, correct: 0, wrong: 0, lastSeen: 0, dueAt: 0, mastery: 0 }; }
function articleClass(article) { return `article-${article}`; }
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2400); }
function showView(view) { $('#game-screen').classList.toggle('hidden', view !== 'game'); $('#results-screen').classList.toggle('hidden', view !== 'results'); $('#online-screen').classList.toggle('hidden', view !== 'online'); $('.app-shell').classList.toggle('hidden', view !== 'home'); window.scrollTo(0, 0); }
function fmtPct(n, d) { return d ? `${Math.round(n / d * 100)}%` : '—'; }
function dayKey(offset = 0) { const date = new Date(); date.setDate(date.getDate() + offset); return `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`; }

function renderHome() {
  const attempts = Object.values(state.stats).reduce((sum, s) => sum + s.correct + s.wrong, 0);
  const correct = Object.values(state.stats).reduce((sum, s) => sum + s.correct, 0);
  const learned = Object.values(state.stats).filter(s => s.mastery >= 4).length;
  const due = Object.values(state.stats).filter(s => s.seen && s.mastery < 4).length;
  $('#stat-learned').innerHTML = `${learned}<span> / ${words.length}</span>`;
  $('#stat-accuracy').textContent = fmtPct(correct, attempts);
  $('#stat-games').textContent = state.games.length;
  $('#stat-points').textContent = state.totalScore.toLocaleString('es-ES');
  $('#stat-best-streak').textContent = state.bestStreak;
  $('#reinforce-note').textContent = due ? `${due} ${due === 1 ? 'palabra pendiente' : 'palabras pendientes'} de reforzar` : 'Las difíciles vuelven antes';
  $('#profile-name').textContent = state.profile || 'Lena';
  $('#avatar').textContent = (state.profile || 'L').trim().charAt(0).toLocaleUpperCase('es');
  const streak = state.daily?.date === dayKey() || state.daily?.date === dayKey(-1) ? state.daily?.streak || 0 : 0;
  $('#header-streak').textContent = `${streak} ${streak === 1 ? 'día' : 'días'} seguidos`;
  $('#mastery-total').textContent = `${learned} aprendidas`;
  for (const article of ['der','die','das']) {
    const pool = words.filter(w => w.article === article);
    const known = pool.filter(w => (state.stats[w.id]?.mastery || 0) >= 4).length;
    $(`#count-${article}`).textContent = `${known} / ${pool.length}`;
    $(`#mastery-${article}`).style.width = `${pool.length ? known / pool.length * 100 : 0}%`;
  }
}

function startGame(length = 20) {
  clearTimeout(timer);
  game = { length, questions: [], current: null, used: new Set(), index: 0, score: 0, correct: 0, wrong: 0, streak: 0, maxStreak: 0, misses: [], startedAt: 0, questionStartedAt: 0, responseTimes: [] };
  showView('game');
  nextQuestion();
}

function nextQuestion() {
  if (isRoundComplete(game.index, game.length)) return finishGame();
  const word = selectWeightedWord(words, state.stats, game.used);
  game.used.add(word.id);
  game.current = word;
  game.index++;
  game.questionStartedAt = performance.now();
  game.answered = false;
  $('#question-word').textContent = word.word;
  $('#word-translation').textContent = word.translation;
  $('#word-category').textContent = word.category.toLocaleUpperCase('es');
  $('#word-hint').textContent = word.hint || '';
  $('#word-hint').classList.toggle('hidden', !word.hint);
  $('#question-kicker').textContent = game.index === 1 ? 'AQUÍ VA LA SIGUIENTE' : 'SIGUIENTE PALABRA';
  $('#question-count').textContent = `PREGUNTA ${game.index}${game.length ? ` / ${game.length}` : ''}`;
  $('#question-progress').style.width = `${game.length ? (game.index - 1) / game.length * 100 : 0}%`;
  $('#current-score').textContent = game.score;
  $('#streak-label').textContent = `✦ Racha: ${game.streak}`;
  $('#feedback').textContent = '';
  $('#feedback').className = 'feedback';
  $$('.answer-button').forEach(button => { button.disabled = false; button.classList.remove('correct-answer','wrong-answer','dimmed'); });
  $('#word-card').classList.remove('word-pop'); void $('#word-card').offsetWidth; $('#word-card').classList.add('word-pop');
}

function answer(article) {
  if (!game || game.answered) return;
  game.answered = true;
  const elapsed = (performance.now() - game.questionStartedAt) / 1000;
  game.responseTimes.push(elapsed);
  const word = game.current;
  const record = statsFor(word.id);
  const buttons = $$('.answer-button');
  buttons.forEach(button => { button.disabled = true; if (button.dataset.article === word.article) button.classList.add('correct-answer'); else if (button.dataset.article === article) button.classList.add('wrong-answer'); else button.classList.add('dimmed'); });
  if (article === word.article) {
    game.correct++;
    game.streak++;
    game.maxStreak = Math.max(game.maxStreak, game.streak);
    const gained = calculateAnswerScore(elapsed, game.streak);
    game.score += gained;
    const cheer = game.streak >= 5 ? ` ¡${game.streak} seguidas!` : '';
    $('#feedback').textContent = `¡Eso es! ${word.article.toLocaleUpperCase()} ${word.word} · +${gained} pts${cheer}`;
    $('#feedback').className = `feedback is-correct ${game.streak >= 3 ? 'streak-pop' : ''}`;
    if (game.streak > 0 && game.streak % 5 === 0) showToast(`¡${game.streak} aciertos seguidos! ✳`);
  } else {
    game.wrong++;
    game.streak = 0;
    game.misses.push(word);
    $('#feedback').textContent = `Casi. Es ${word.article.toLocaleUpperCase()} ${word.word} — ${word.translation}.`;
    $('#feedback').className = 'feedback is-wrong';
  }
  Object.assign(record, applyWordResult(record, article === word.article));
  $('#current-score').textContent = game.score;
  $('#streak-label').textContent = `✦ Racha: ${game.streak}`;
  $('#question-progress').style.width = `${game.length ? game.index / game.length * 100 : 0}%`;
  save(); renderHome();
  timer = setTimeout(nextQuestion, 1250);
}

function finishGame() {
  clearTimeout(timer);
  const { accuracy, average } = summarizeRound(game.correct, game.wrong, game.responseTimes);
  state.totalScore += game.score;
  state.bestStreak = Math.max(state.bestStreak, game.maxStreak);
  const today = dayKey();
  const yesterdayKey = dayKey(-1);
  if (state.daily?.date !== today) state.daily = { date: today, streak: state.daily?.date === yesterdayKey ? (state.daily.streak || 0) + 1 : 1 };
  const prior = state.games.at(-1);
  const gameRecord = { date: new Date().toISOString(), correct: game.correct, wrong: game.wrong, accuracy, score: game.score, maxStreak: game.maxStreak, average };
  state.games.push(gameRecord);
  $('#result-title').textContent = accuracy >= 90 ? '¡Imparable!' : accuracy >= 70 ? '¡Bien jugado!' : '¡Cada vez mejor!';
  $('#result-subtitle').textContent = prior ? `${accuracy >= prior.accuracy ? `↑ ${accuracy - prior.accuracy} puntos de precisión más que la anterior.` : `La siguiente ronda es tu oportunidad para superar el ${prior.accuracy}%.`}` : '¡Ya tienes tu primera ronda en el bolsillo!';
  $('#result-score').textContent = game.score;
  $('#result-correct').textContent = game.correct;
  $('#result-wrong').textContent = game.wrong;
  $('#result-percent').textContent = `${accuracy}%`;
  $('#result-time').textContent = `${average.toFixed(1)} s`;
  const missed = game.misses.slice(0, 8);
  const confusions = Object.fromEntries(['der','die','das'].map(article => [article, game.misses.filter(word => word.article === article).length]));
  const mostConfused = Object.entries(confusions).sort((a,b) => b[1]-a[1]).filter(([,count]) => count > 0).slice(0, 1);
  const confusionNote = mostConfused.length ? `<div class="confusion-note">Más respuestas por reforzar: <b class="${articleClass(mostConfused[0][0])}">${mostConfused[0][0].toLocaleUpperCase()}</b> (${mostConfused[0][1]} ${mostConfused[0][1] === 1 ? 'palabra' : 'palabras'}).</div>` : '';
  $('#wrong-list').innerHTML = missed.length ? `<div class="wrong-list-title">UN REPASO RÁPIDO</div>${confusionNote}<div class="missed-words">${missed.map(w => `<span><b class="${articleClass(w.article)}">${w.article.toLocaleUpperCase()}</b> ${w.word} <small>${w.translation}</small></span>`).join('')}</div>${game.misses.length > missed.length ? `<small class="missed-more">y ${game.misses.length - missed.length} más: volverán pronto en próximas rondas.</small>` : ''}` : '<div class="all-correct">✳ Perfecto. No hay palabras para repasar.</div>';
  save(); renderHome(); showView('results');
}

function startSelected() { startGame(Number($('.length-option.selected')?.dataset.length ?? 20)); }
$('#start-main').addEventListener('click', () => startGame(20));
$('#start-selected').addEventListener('click', startSelected);
$$('.length-option').forEach(button => button.addEventListener('click', () => { $$('.length-option').forEach(item => item.classList.remove('selected')); button.classList.add('selected'); }));
$$('.answer-button').forEach(button => button.addEventListener('click', () => answer(button.dataset.article)));
$('#quit-game').addEventListener('click', () => { if (confirm('¿Salir de esta ronda? Se conservarán tus respuestas, pero la partida incompleta no contará en el historial.')) { clearTimeout(timer); game = null; showView('home'); } });
$('#play-again').addEventListener('click', () => startGame(game?.length || 20));
$('#back-home').addEventListener('click', () => { game = null; showView('home'); });
$('#profile-open').addEventListener('click', () => { $('#name-input').value = state.profile || ''; $('#profile-dialog').showModal(); });
$('#profile-dialog').addEventListener('submit', event => { if (event.submitter?.id === 'save-profile') { const name = $('#name-input').value.trim(); if (name) { state.profile = name; save(); renderHome(); } } });
$('#reset-data').addEventListener('click', () => { if (confirm('¿Borrar el perfil, las estadísticas y el progreso guardado?')) { localStorage.removeItem(STORAGE_KEY); state = blankState(); save(); renderHome(); showToast('Progreso reiniciado. ¡A empezar!'); } });
document.addEventListener('keydown', event => {
  if (!game || $('#game-screen').classList.contains('hidden')) return;
  if (event.key === 'Escape') { $('#quit-game').click(); return; }
  const article = { '1': 'der', '2': 'die', '3': 'das' }[event.key];
  if (article) answer(article);
});

const quality = validateWordBank();
if (quality.errors.length) console.warn('Revisar banco de palabras:', quality.errors);
console.info(`Deutsch Brava: ${quality.count} palabras cargadas; revisión estructural: ${quality.errors.length} avisos.`);
renderHome();
const onlineRoom = new OnlineRoomController({ onClose: () => showView('home'), onToast: showToast });
$('#friends-open').addEventListener('click', () => { showView('online'); onlineRoom.open(); });

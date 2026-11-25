/** Selecciona palabras ponderando errores, vencimiento de repaso, dominio y antigüedad. */
export function selectWeightedWord(pool, stats = {}, used = new Set(), now = Date.now(), random = Math.random) {
  if (!pool.length) return null;
  const available = pool.filter(word => !used.has(word.id));
  const candidates = available.length ? available : pool;
  const weighted = candidates.map(word => {
    const record = stats[word.id] || {};
    const dueBoost = record.dueAt && record.dueAt <= now ? 3.4 : 1;
    const mistakeBoost = 1 + Math.min(record.wrong || 0, 8) * .48;
    const masteryBoost = 1 / (1 + Math.max(0, record.mastery || 0) * .48);
    const ageBoost = record.lastSeen ? Math.min(3, 1 + (now - record.lastSeen) / (1000 * 60 * 60 * 24 * 3)) : 1.5;
    return { word, weight: dueBoost * mistakeBoost * masteryBoost * ageBoost };
  });
  let needle = random() * weighted.reduce((sum, entry) => sum + entry.weight, 0);
  for (const entry of weighted) { needle -= entry.weight; if (needle <= 0) return entry.word; }
  return weighted.at(-1).word;
}

export function calculateAnswerScore(elapsedSeconds, streak) {
  const speedBonus = elapsedSeconds < 1.8 ? 15 : elapsedSeconds < 3.5 ? 8 : 0;
  return 100 + speedBonus + Math.min(40, Math.max(0, streak - 1) * 5);
}

export function applyWordResult(record, correct, now = Date.now()) {
  const updated = { ...record, seen: (record.seen || 0) + 1, lastSeen: now };
  if (correct) {
    updated.correct = (record.correct || 0) + 1;
    updated.mastery = Math.min(6, (record.mastery || 0) + 1);
    updated.dueAt = now + Math.min(30, Math.max(1, updated.mastery * updated.mastery)) * 24 * 60 * 60 * 1000;
  } else {
    updated.wrong = (record.wrong || 0) + 1;
    updated.mastery = Math.max(0, (record.mastery || 0) - 1);
    updated.dueAt = now + 5 * 60 * 1000;
  }
  return updated;
}

export function summarizeRound(correct, wrong, responseTimes) {
  const total = correct + wrong;
  return { total, accuracy: total ? Math.round(correct / total * 100) : 0, average: responseTimes.length ? responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length : 0 };
}

export function isRoundComplete(answered, length) {
  return length > 0 && answered >= length;
}

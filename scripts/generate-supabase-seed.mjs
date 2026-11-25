import { writeFile } from 'node:fs/promises';
import { words } from '../src/words.js';

const quote = value => `'${String(value ?? '').replaceAll("'", "''")}'`;
const inserts = words.map(word => `(${quote(word.id)},${quote(word.word)},${quote(word.article)},${quote(word.translation)},${quote(word.category)},${quote(word.level)},${quote(word.plural)})`);
const sql = `-- Generated from src/words.js. Re-run with: node scripts/generate-supabase-seed.mjs\ninsert into public.brava_words (id,noun,article,translation,category,level,plural) values\n${inserts.join(',\n')}\non conflict (id) do update set noun=excluded.noun, article=excluded.article, translation=excluded.translation, category=excluded.category, level=excluded.level, plural=excluded.plural;\n`;
await writeFile(new URL('../supabase/seed.sql', import.meta.url), sql, 'utf8');
console.log(`Generated Supabase seed for ${words.length} words.`);

// backend/export-members.cjs
// Usage exemples :
//   node -r dotenv/config export-members.cjs --table members
//   node -r dotenv/config export-members.cjs --schema auth --table users --cols "id,email,created_at"
//   node -r dotenv/config export-members.cjs --table members --cols "id,full_name,email,credits" --outfile ./exports/members.csv

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

/* ---------------------- CLI args ---------------------- */
function argVal(flag, defVal) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : defVal;
}
const schema = argVal('--schema', 'public');          // <- schéma par défaut : public
const table = argVal('--table', 'members');           // <- table par défaut : members
const colsArg = argVal('--cols', '');                 // "id,email,created_at"
const outArg  = argVal('--outfile', '');              // chemin explicite
const limit   = Number(argVal('--limit', '0')) || 0;  // 0 = pas de limite

/* ---------------------- ENV ---------------------- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    '❌ Variables manquantes: SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY. ' +
      'Ajoute-les dans .env (backend/) ou en variables d’environnement.'
  );
  process.exit(1);
}

/* ---------------------- Client ---------------------- */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* ---------------------- CSV helpers ---------------------- */
function toCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0] ?? {});

  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    const needsQuotes = /[",;\n]/.test(s);
    const doubled = s.replace(/"/g, '""');
    return needsQuotes ? `"${doubled}"` : doubled;
  };

  const lines = [
    headers.join(';'),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(';')),
  ];

  return lines.join('\n');
}

/* ---------------------- Run ---------------------- */
(async () => {
  try {
    console.log(`➡️  Export depuis ${schema}.${table}`);

    // Si cols non fournis : on tente un set raisonnable
    let columns = colsArg
      ? colsArg.split(',').map((s) => s.trim()).filter(Boolean)
      : ['id', 'email', 'created_at', 'updated_at', 'full_name', 'first_name', 'last_name', 'phone', 'credits', 'is_active'];

    // On construit la requête en tenant compte du schéma
    let query = supabase.schema(schema).from(table).select(columns.join(','));
    if (limit > 0) query = query.limit(limit);
    // si la table n’a pas created_at, ce order sera ignoré par PostgREST (donc OK)
    query = query.order('created_at', { ascending: true });

    const { data, error } = await query;

    if (error) {
      console.error('❌ Erreur Supabase:', error.message);
      process.exit(1);
    }

    const arr = Array.isArray(data) ? data : [];
    if (arr.length === 0) {
      console.log('ℹ️  Aucune ligne retournée.');
    }

    // Si certaines colonnes n’existent pas, on réduit dynamiquement l’export
    // à celles réellement présentes dans la réponse.
    if (arr.length > 0) {
      const returnedKeys = Object.keys(arr[0]);
      columns = columns.filter((c) => returnedKeys.includes(c));
    }

    const csv = toCsv(
      arr.map((row) => {
        const obj = {};
        for (const c of columns) obj[c] = row[c];
        return obj;
      })
    );

    // Chemin de sortie
    const outDir = path.join(__dirname, 'exports');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = outArg
      ? path.resolve(__dirname, outArg)
      : path.join(outDir, `${schema}-${table}-${ts}.csv`);

    fs.writeFileSync(outPath, csv, 'utf8');

    console.log(`✅ Export terminé : ${outPath}`);
    console.log(`ℹ️ ${arr.length} lignes exportées.`);
  } catch (e) {
    console.error('❌ Exception:', e);
    process.exit(1);
  }
})();

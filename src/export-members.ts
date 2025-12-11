// backend/export-members.js
// Usage :
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node export-members.cjs --table profiles
//   (ou via un .env : node -r dotenv/config export-members.cjs --table profiles)
// Options :
//   --table <nom>         (par défaut: members)
//   --cols  "id,email,..."  liste de colonnes à exporter (sinon auto)
//   --outfile <path>        chemin du fichier de sortie (sinon backend/exports/members-<table>-<timestamp>.csv)

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

/* ------------------------- Args & ENV ------------------------- */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getArg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const argTable = getArg('--table', 'members');
const argCols = getArg('--cols', null); // "id,email,phone"
const argOutfile = getArg('--outfile', null);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    '❌ Variables d’environnement manquantes.\n' +
      '   Définis SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY (clé *service role*).'
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* ---------------------- Colonnes par défaut ------------------- */

const DEFAULT_COLUMNS = [
  'id',
  'full_name',
  'email',
  'phone',
  'created_at',
  'is_active',
  'credits',
  'notes',
];

const PROFILE_COLUMNS = [
  'id',
  'email',
  'phone',
  'first_name',
  'last_name',
  'created_at',
  'updated_at',
  'status',
  'credits',
];

/* --------------------------- CSV utils ------------------------ */

function valueToString(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch (_) {
      return String(v);
    }
  }
  return String(v);
}

function escapeCsvField(s) {
  // séparateur ; (Excel FR)
  const needsQuotes = /[",;\n]/.test(s);
  const doubled = s.replace(/"/g, '""');
  return needsQuotes ? `"${doubled}"` : doubled;
}

function toCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const headLine = headers.join(';');
  const lines = rows.map((r) =>
    headers.map((h) => escapeCsvField(valueToString(r[h]))).join(';')
  );
  return [headLine, ...lines].join('\n');
}

/* --------------------- Fetch avec pagination ------------------ */

async function fetchAll(table, columns) {
  const pageSize = 1000;
  let from = 0;
  let to = from + pageSize - 1;
  const acc = [];

  // Si columns est null -> on fera un premier SELECT * pour déduire les colonnes
  let cols = columns;

  // Premier batch
  let q = supabase.from(table);
  q = cols ? q.select(cols.join(',')) : q.select('*');
  // On essaye d'ordonner si created_at existe — on ajustera après si ça plante
  q = q.order('created_at', { ascending: true }).range(from, to);

  let { data, error } = await q;

  if (error) {
    // Si l'erreur vient d'un ORDER BY created_at manquant, on réessaye sans order
    if (error.message && /column .*created_at.* does not exist/i.test(error.message)) {
      let q2 = supabase.from(table);
      q2 = cols ? q2.select(cols.join(',')) : q2.select('*');
      ({ data, error } = await q2.range(from, to));
    }
  }

  if (error) throw error;
  if (!data) return [];

  // Si on n'avait pas de colonnes, on les déduit du premier batch
  if (!cols) cols = Object.keys(data[0] || {});

  acc.push(...data);

  // Batches suivants
  while (data.length === pageSize) {
    from += pageSize;
    to += pageSize;
    let qn = supabase.from(table).select(cols.join(',')).range(from, to);
    const res = await qn;
    if (res.error) throw res.error;
    data = res.data || [];
    acc.push(...data);
  }

  return acc;
}

/* ------------------------------ Main -------------------------- */

(async () => {
  try {
    console.log(`➡️  Export table: ${argTable}`);

    let chosenCols = null;
    if (argCols) {
      chosenCols = argCols
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
    } else {
      // mapping auto simple
      chosenCols = argTable === 'profiles' ? PROFILE_COLUMNS : DEFAULT_COLUMNS;
    }

    // Récupération (avec fallback si certaines colonnes n'existent pas)
    let rows;
    try {
      rows = await fetchAll(argTable, chosenCols);
    } catch (e) {
      console.warn(
        '⚠️  Échec avec colonnes prédéfinies, tentative avec SELECT * pour déduire la structure…'
      );
      rows = await fetchAll(argTable, null);
      // Après coup on réduit aux colonnes d'intérêt si on en a
      if (Array.isArray(rows) && rows.length > 0 && chosenCols) {
        rows = rows.map((r) => {
          const o = {};
          for (const k of chosenCols) o[k] = r[k];
          return o;
        });
      }
    }

    const csv = toCsv(rows);

    const outDir = path.join(__dirname, 'exports');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const defaultOut = path.join(outDir, `members-${argTable}-${ts}.csv`);
    const outPath = argOutfile ? path.resolve(argOutfile) : defaultOut;

    fs.writeFileSync(outPath, csv, 'utf8');

    console.log(`✅ Export terminé : ${outPath}`);
    console.log(`ℹ️ ${rows.length} ligne(s) exportée(s).`);
  } catch (e) {
    console.error('❌ Erreur export:', e?.message || e);
    process.exit(1);
  }
})();

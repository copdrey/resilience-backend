// backend/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

// ───────────────────────────────────────────────────────────
// ENV
// ───────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ ENV manquantes: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}



// GoCardless (facultatif)
const GC_BASE = process.env.GC_BASE; // ex: https://api.gocardless.com ou sandbox
const GC_ACCESS_TOKEN = process.env.GC_ACCESS_TOKEN;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // ex: http://localhost:4000
const DEEP_LINK_SCHEME = process.env.DEEP_LINK_SCHEME || 'resilience';

// ───────────────────────────────────────────────────────────
// App + Supabase
// ───────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));
// ───────────────────────────────────────────────────────────


// ───────────────────────────────────────────────────────────
// Helpers crédits / roster / remplissage
// ───────────────────────────────────────────────────────────
async function getMemberBalance(memberId) {
  const { data, error } = await supabase
    .from('member_credits_ledger')
    .select('delta')
    .eq('member_id', memberId);

  if (error) throw error;
  return (data || []).reduce((sum, r) => sum + (r?.delta || 0), 0);
}

async function changeMemberCredits({ memberId, delta, source, note, productId = null }) {
  const { error } = await supabase.from('member_credits_ledger').insert({
    member_id: memberId,
    delta,
    source,
    note,
    product_id: productId,
  });
  if (error) throw error;
}

async function getCourseRoster(courseId) {
  // 1) récup les inscriptions
  const { data: rows, error: e1 } = await supabase
    .from('enrollments')
    .select('member_id')
    .eq('course_id', courseId)
    .order('created_at', { ascending: true });

  if (e1) throw e1;
  if (!rows?.length) return [];

// ——— Admin: remplissage + roster d'un cours ——————————————
// GET /admin/courses/:courseId/fill -> { course_id, enrolled, capacity, roster: [{member_id, first_name, last_name}] }
app.get('/admin/courses/:courseId/fill', async (req, res) => {
  try {
    const { courseId } = req.params;

    // capacité du cours
    const { data: course, error: eCourse } = await supabase
      .from('courses')
      .select('id, capacity')
      .eq('id', courseId)
      .single();
    if (eCourse || !course) return res.status(404).json({ error: 'Cours introuvable' });
    const { data: enr, error: eEnr } = await supabase
          .from('enrollments')
          .select('member_id, members(first_name,last_name)')
          .eq('course_id', courseId);

        if (eEnr) throw eEnr;

    // nombre d'inscrits
    const { count, error: eCount } = await supabase
      .from('enrollments')
      .select('id', { count: 'exact', head: true })
      .eq('course_id', courseId);
    if (eCount) throw eCount;

    // roster détaillé
    const roster = (enr ?? []).map((r: any) => ({
          member_id: r.member_id,
          first_name: r.members?.first_name ?? '',
          last_name: r.members?.last_name ?? '',
        }));

        res.json({
          course_id: courseId,
          enrolled: roster.length,
          capacity: course.capacity ?? 0,
          roster,
        });
      } catch (e: any) {
        console.error(e);
        res.status(500).json({ error: 'fill failed' });
      }
});
app.post('/admin/courses/:courseId/enroll', async (req, res) => {
  try {
    const { courseId } = req.params;
    const { member_id, requireCredits = true } = req.body || {};
    if (!courseId || !member_id) return res.status(400).json({ error: 'courseId et member_id requis' });
  // 2) récup infos membres
  const ids = Array.from(new Set(rows.map(r => r.member_id)));
  const { data: members, error: e2 } = await supabase
    .from('members')
    .select('id, first_name, last_name, full_name, email')
    .in('id', ids);

  if (e2) throw e2;
  const map = new Map((members || []).map(m => [m.id, m]));

  return rows.map(r => {
    const m = map.get(r.member_id) || {};
    const name =
      m.full_name ||
      [m.first_name, m.last_name].filter(Boolean).join(' ').trim() ||
      r.member_id;
    return {
      member_id: r.member_id,
      name,
      email: m.email || '',
    };
  });
}

async function getCourseFill(courseId) {
  const [{ data: course, error: eCourse }, roster] = await Promise.all([
    supabase.from('courses').select('id, name, capacity').eq('id', courseId).single(),
    getCourseRoster(courseId),
  ]);
  if (eCourse) throw eCourse;
  if (!course) throw new Error('Cours introuvable');

  const capacity = course.capacity ?? 0;
  const enrolledCount = roster.length;
  const fillRate = capacity ? Math.round((enrolledCount / capacity) * 100) : 0;

  return {
    courseId,
    courseName: course.name,
    capacity,
    enrolledCount,
    fillRate,
    enrolledNames: roster.map(r => r.name),
    roster,
  };
}

// ───────────────────────────────────────────────────────────
// Routes Admin: remplissage / inscription / désinscription
// ───────────────────────────────────────────────────────────

// GET : remplissage + noms
app.get('/admin/courses/:id/fill', async (req, res) => {
  try {
    const info = await getCourseFill(req.params.id);
    res.json(info);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Impossible de récupérer le remplissage' });
  }
});

// POST : inscrire un membre (décrément 1 crédit si requireCredits=true)
app.post('/courses/:courseId/enroll', async (req, res) => {
  try {
    const { courseId } = req.params;
    const { member_id: memberId, requireCredits = true } = req.body || {};
    if (!courseId || !memberId) return res.status(400).json({ error: 'courseId et member_id requis' });

    // capacité
    const { data: course, error: eCourse } = await supabase
      .from('courses')
      .select('id, capacity')
      .eq('id', courseId)
      .single();
    if (eCourse || !course) return res.status(404).json({ error: 'Cours introuvable' });

    // déjà inscrit ?
    const { data: existing, error: eExists } = await supabase
      .from('enrollments')
      .select('member_id')
      .eq('course_id', courseId)
      .eq('member_id', memberId)
      .maybeSingle();
    if (eExists) throw eExists;
    if (existing) return res.status(409).json({ error: 'Déjà inscrit' });

    // places restantes ?
    const { count } = await supabase
      .from('enrollments')
      .select('member_id', { count: 'exact', head: true })
      .eq('course_id', courseId);
    if ((count ?? 0) >= (course.capacity ?? 0)) {
      return res.status(409).json({ error: 'Cours complet' });
    }

    // crédits
    if (requireCredits) {const { data: ledger } = await supabase
                                 .from('credits_ledger')
                                 .select('delta')
                                 .eq('member_id', member_id);
                               const balance = (ledger ?? []).reduce((s, r: any) => s + (r.delta || 0), 0);
      if (balance <= 0) return res.status(402).json({ error: 'Crédits insuffisants' });
    }

    // inscrire
    const { error: eIns } = await supabase
    .from('enrollments').insert({ course_id: courseId, member_id: memberId });
    if (eIns) throw eIns;

    // ledger -1
    if (requireCredits) {
      await supabase.from('credits_ledger').insert({
              member_id,
              delta: -1,
              note: `Inscription cours ${courseId}`,
            });
    }

    const roster = await getCourseRoster(courseId);
    res.json({
      ok: true,
      roster,
      enrolled: (count ?? 0) + 1,
      capacity: course.capacity ?? 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Inscription impossible' });
  }
});

// DELETE : désinscrire (refund=1 pour recréditer)
app.delete('/courses/:courseId/enroll/:memberId', async (req, res) => {
  try {
    const { courseId, memberId } = req.params;
    const refund = String(req.query.refund || '0') === '1';

    const { error: eDel } = await supabase
      .from('enrollments')
      .delete()
      .match({ course_id: courseId, member_id: memberId });
    if (eDel) throw eDel;

    if (refund) {
      await changeMemberCredits({
        memberId,
        delta: +1,
        source: 'unbooking',
        note: `Désinscription cours ${courseId}`,
      });
    }

    const roster = await getCourseRoster(courseId);
    res.json({ ok: true, roster });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Désinscription impossible' });
  }
});

// roster brut
app.get('/courses/:courseId/roster', async (req, res) => {
  try {
    const roster = await getCourseRoster(req.params.courseId);
    res.json({ roster });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Roster indisponible' });
  }
});

// ───────────────────────────────────────────────────────────
// Produits de crédits & dotations
// ───────────────────────────────────────────────────────────

// créer un produit
app.post('/credits/products', async (req, res) => {
  try {
    const { name, credits, price_cents, biody = false, active = true } = req.body || {};
    if (!name || !Number.isInteger(credits) || !Number.isInteger(price_cents)) {
      return res.status(400).json({ error: 'name, credits(int), price_cents(int) requis' });
    }
    const { data, error } = await supabase
      .from('credit_products')
      .insert({ name, credits, price_cents, biody, active })
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, product: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Création offre impossible' });
  }
});
app.post('/credits/grant', async (req, res) => {
  try {
    const { member_id, delta, note } = req.body || {};
    if (!member_id || typeof delta !== 'number') {
      return res.status(400).send('member_id et delta sont requis');
    }

    const { error } = await supabase.from('credits_ledger').insert({
      member_id,
      delta,
      note: note ?? null,
    });
    if (error) throw error;

    // Retourner le nouveau solde
    const { data, error: e2 } = await supabase
      .from('credits_ledger')
      .select('delta')
      .eq('member_id', member_id);

    if (e2) throw e2;
    const balance = (data ?? []).reduce((s, r: any) => s + (r.delta || 0), 0);
    res.json({ ok: true, balance });
  } catch (e: any) {
    console.error(e);
    res.status(500).send(e?.message ?? 'grant failed');
  }
});
// lister produits
app.get('/credits/products', async (req, res) => {
  try {
    let q = supabase.from('credit_products').select('*').order('active', { ascending: false });
    if (req.query.active === '1') q = q.eq('active', true);
    if (req.query.active === '0') q = q.eq('active', false);
    if (req.query.biody === '1') q = q.eq('biody', true);
    if (req.query.biody === '0') q = q.eq('biody', false);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ products: data || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lecture offres impossible' });
  }
});

// solde membre
app.get('/credits/balance/:memberId', async (req, res) => {
  try {
    const memberId = req.params.memberId;
        const { data, error } = await supabase
          .from('credits_ledger')
          .select('delta')
          .eq('member_id', memberId);

        if (error) throw error;
        const balance = (data ?? []).reduce((s, r: any) => s + (r.delta || 0), 0);
        res.json({ member_id: memberId, balance });
      } catch (e: any) {
        console.error(e);
        res.status(500).send(e?.message ?? 'balance failed');
      }
    });

// dotation manuelle
app.post('/credits/grant', async (req, res) => {
  try {
    const { member_id: memberId, delta, note } = req.body || {};
    if (!memberId || !Number.isInteger(delta)) {
      return res.status(400).json({ error: 'member_id et delta(int) requis' });
    }
    await changeMemberCredits({
      memberId,
      delta,
      source: 'admin',
      note: note || 'Ajustement admin',
    });
    const balance = await getMemberBalance(memberId);
    res.json({ ok: true, balance });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Dotation impossible' });
  }
});

// ───────────────────────────────────────────────────────────
// Exports membres JSON / CSV
// ───────────────────────────────────────────────────────────
function toCsv(rows) {
  if (!rows?.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = (v) =>
    v == null ? '' : String(v).includes(',') || String(v).includes('"') || String(v).includes('\n')
      ? `"${String(v).replace(/"/g, '""')}"`
      : String(v);
  const lines = [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(',')));
  return lines.join('\n');
}

app.get('/members/export.json', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('members')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ members: data ?? [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Export JSON impossible' });
  }
});

app.get('/members/export.csv', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('members')
      .select('id, email, first_name, last_name, full_name, phone, created_at, updated_at')
      .order('created_at', { ascending: true });
    if (error) throw error;

    const rows = data ?? [];
    const csv = toCsv(rows);
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="members-${ts}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).send('Export CSV impossible');
  }
});

// ───────────────────────────────────────────────────────────
// Routes GoCardless (enregistrées seulement si env présents)
// ───────────────────────────────────────────────────────────
if (GC_BASE && GC_ACCESS_TOKEN && PUBLIC_BASE_URL) {
  // Créer redirect flow
  app.post('/gc/redirect', async (req, res) => {
    try {
      const { sessionToken, customer } = req.body ?? {};
      if (!sessionToken) return res.status(400).json({ error: 'sessionToken requis' });

      const success_redirect_url = `${PUBLIC_BASE_URL}/gc/success?session_token=${encodeURIComponent(
        sessionToken
      )}`;

      const payload = {
        redirect_flows: {
          description: 'Mandat SEPA Résilience Studio',
          session_token: sessionToken,
          success_redirect_url,
          ...(customer ? { prefilled_customer: customer } : {}),
        },
      };

      const resp = await fetch(`${GC_BASE}/redirect_flows`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GC_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error('GC /redirect error:', resp.status, text);
        return res.status(resp.status).send(text);
      }

      const data = await resp.json();
      const redirectUrl =
        data?.redirect_flows?.redirect_url ||
        data?.data?.redirect_flows?.redirect_url ||
        data?.data?.redirect_url;

      if (!redirectUrl) return res.status(500).json({ error: 'redirect_url manquant' });

      res.json({ redirectUrl });
    } catch (e) {
      console.error('GC /redirect exception:', e);
      res.status(500).json({ error: 'Erreur création redirect flow' });
    }
  });

  // Callback succès
  app.get('/gc/success', async (req, res) => {
    try {
      const { redirect_flow_id, session_token } = req.query;
      if (!redirect_flow_id || !session_token) {
        return res.status(400).send('redirect_flow_id ou session_token manquant');
      }

      const completeResp = await fetch(
        `${GC_BASE}/redirect_flows/${redirect_flow_id}/actions/complete`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${GC_ACCESS_TOKEN}`,
            'GoCardless-Version': '2015-07-06',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ data: { session_token } }),
        }
      );

      if (!completeResp.ok) {
        const text = await completeResp.text();
        console.error('GC /success complete error:', completeResp.status, text);
        return res.status(completeResp.status).send(text);
      }

      const completeData = await completeResp.json();
      const links =
        completeData?.redirect_flows?.links ||
        completeData?.data?.redirect_flows?.links ||
        completeData?.data?.links ||
        {};

      const customer = links.customer ?? '';
      const mandate = links.mandate ?? '';

      // Deep link vers l’app
      const url = `${DEEP_LINK_SCHEME}://gc/success?customer=${encodeURIComponent(
        customer
      )}&mandate=${encodeURIComponent(mandate)}`;

      return res.redirect(302, url);
    } catch (e) {
      console.error('GC /success exception:', e);
      res.status(500).send('Erreur completion redirect flow');
    }
  });
} else {
  console.warn('⚠️ GC non configuré (GC_BASE / GC_ACCESS_TOKEN / PUBLIC_BASE_URL absents) : routes GC désactivées.');
}

// ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Backend démarré sur http://localhost:${PORT}`);
});

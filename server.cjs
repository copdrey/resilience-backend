require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PORT = 4000
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const app = express();

app.use(cors());
app.use(bodyParser.json());

// ✅ Route de santé
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ✅ Route de réservation (V53 compatible)
app.post('/api/reservations', async (req, res) => {
  try {
    console.log('[Reservation] Request:', req.body);

    const { course_id, user_id } = req.body;

    if (!course_id || !user_id) {
      return res.status(400).json({ error: 'course_id et user_id requis' });
    }

    // 1. Vérifier que le cours existe
    const { data: course, error: courseError } = await supabase
      .from('course_instances')
      .select('id, capacity, available')
      .eq('id', course_id)
      .single();

    if (courseError || !course) {
      return res.status(404).json({ error: 'Cours introuvable' });
    }

    if (course.available === false) {
      return res.status(400).json({ error: 'Ce cours n\'est pas disponible' });
    }

    // 2. Compter les inscrits
    const { count: enrolledCount } = await supabase
      .from('reservations')
      .select('*', { count: 'exact', head: true })
      .eq('course_id', course_id)
      .eq('status', 'confirmed');

    if (enrolledCount >= course.capacity) {
      return res.status(400).json({ error: 'Cours complet' });
    }

    // 3. Vérifier que l'utilisateur n'est pas déjà inscrit
    const { data: existingReservation } = await supabase
      .from('reservations')
      .select('id')
      .eq('course_id', course_id)
      .eq('user_id', user_id)
      .eq('status', 'confirmed')
      .maybeSingle();

    if (existingReservation) {
      return res.status(400).json({ error: 'Vous êtes déjà inscrit à ce cours' });
    }

    // 4. Vérifier les crédits (user_credits d'abord, puis users)
    let credits = 0;
    const { data: userCredits, error: creditsError } = await supabase
      .from('user_credits')
      .select('credits')
      .eq('user_id', user_id)
      .maybeSingle();

    if (creditsError || !userCredits) {
      // Fallback : users.credits
      const { data: userData } = await supabase
        .from('users')
        .select('credits')
        .eq('id', user_id)
        .single();

      credits = userData?.credits || 0;
    } else {
      credits = userCredits.credits || 0;
    }

    if (credits < 1) {
      return res.status(400).json({ error: 'Crédits insuffisants' });
    }

    // 5. Créer la réservation
    const { data: reservation, error: reservationError } = await supabase
      .from('reservations')
      .insert({
        user_id: user_id,
        course_id: parseInt(course_id),
        status: 'confirmed',
        reserved_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (reservationError) {
      console.error('[Reservation] Error creating reservation:', reservationError);
      throw new Error(reservationError.message);
    }

    console.log('[Reservation] Created:', reservation.id);

    // 6. Déduire 1 crédit (user_credits d'abord)
    const { error: updateCreditsError } = await supabase
      .from('user_credits')
      .update({
        credits: credits - 1,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', user_id);

    if (updateCreditsError) {
      console.warn('[Reservation] user_credits update failed, trying users.credits');
      // Fallback : users.credits
      await supabase
        .from('users')
        .update({ credits: credits - 1 })
        .eq('id', user_id);
    }

    console.log('[Reservation] Credits updated:', credits - 1);

    res.json({
      success: true,
      reservation,
      credits_remaining: credits - 1
    });

  } catch (error) {
    console.error('[Reservation] Error:', error);
    res.status(500).json({ error: error.message || 'Erreur lors de la réservation' });
  }
});

// Route pour coaching checkout
app.post('/api/coaching/checkout', async (req, res) => {
  try {
    const { member_id, program_id } = req.body;
    if (!member_id || !program_id) {
      return res.status(400).json({ error: 'member_id and program_id are required' });
    }

    // Récupérer le programme (prix)
    const { data: prog, error: pe } = await supabase
      .from('coach_programs')
      .select('id, price_cents, videos')
      .eq('id', program_id)
      .single();
    if (pe || !prog) return res.status(400).json({ error: pe?.message || 'Program not found' });

    // Créer l'achat
    const { error: ip } = await supabase.from('purchases').insert({
      member_id,
      product_type: 'coaching_program',
      quantity: 1,
      amount_cents: prog.price_cents,
      status: 'paid',
    });
    if (ip) return res.status(500).json({ error: ip.message });

    // Créer l'enrôlement si pas déjà présent
    const { data: existing } = await supabase
      .from('coach_enrollments')
      .select('program_id')
      .eq('program_id', program_id)
      .eq('member_id', member_id)
      .maybeSingle();

    if (!existing) {
      const { error: ie } = await supabase.from('coach_enrollments').insert({
        program_id,
        member_id,
        progress: 0,
        completed_sessions: 0,
        total_sessions: prog.videos || 0,
      });
      if (ie) return res.status(500).json({ error: ie.message });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// Route pour créer un redirect flow GoCardless (achats de crédits)
app.post('/gc/redirect-flow', async (req, res) => {
  try {
    const { sessionToken, amount, description, metadata } = req.body;

    if (!sessionToken || !amount || !description) {
      return res.status(400).json({ error: 'Paramètres manquants' });
    }

    // Créer le redirect flow GoCardless
    const redirectFlow = await fetch(`${process.env.GC_BASE}/redirect_flows`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GC_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        redirect_flows: {
          description: description,
          session_token: sessionToken,
          success_redirect_url: process.env.GC_SUCCESS_REDIRECT_URL || 'http://localhost:4000/gc/success',
          prefilled_customer: {
            given_name: metadata?.userName || '',
            email: metadata?.userEmail || '',
          },
          metadata: {
            ...metadata,
            amount: amount.toString(),
          },
        },
      }),
    });

    const data = await redirectFlow.json();

    if (!redirectFlow.ok) {
      throw new Error(data.error?.message || 'Erreur GoCardless');
    }

    res.json({
      redirectUrl: data.redirect_flows.redirect_url,
      sessionToken,
      flowId: data.redirect_flows.id,
    });
  } catch (error) {
    console.error('[GC] Erreur redirect flow:', error);
    res.status(500).json({ error: error.message });
  }
});

// Route callback GoCardless après paiement
app.get('/gc/success', async (req, res) => {
  try {
    const { redirect_flow_id } = req.query;

    if (!redirect_flow_id) {
      return res.status(400).send('Missing redirect_flow_id');
    }

    // Compléter le redirect flow
    const completeFlow = await fetch(
      `${process.env.GC_BASE}/redirect_flows/${redirect_flow_id}/actions/complete`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GC_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: {
            session_token: req.query.session_token,
          },
        }),
      }
    );

    const flowData = await completeFlow.json();

    if (!completeFlow.ok) {
      throw new Error('Erreur completion flow');
    }

    const metadata = flowData.redirect_flows.metadata || {};
    const userId = metadata.userId;
    const credits = parseInt(metadata.credits || '0');
    const amount = parseFloat(metadata.amount || '0');

    // Enregistrer l'achat dans credit_purchases
    const { error: purchaseError } = await supabase
      .from('credit_purchases')
      .insert({
        user_id: userId,
        amount: amount,
        credits_quantity: credits,
        payment_status: 'completed',
        payment_method: 'gocardless',
        transaction_id: flowData.redirect_flows.id,
      });

    if (purchaseError) throw purchaseError;

    // Mettre à jour les crédits de l'utilisateur
    const { data: currentCredits } = await supabase
      .from('user_credits')
      .select('credits')
      .eq('user_id', userId)
      .maybeSingle();

    if (currentCredits) {
      await supabase
        .from('user_credits')
        .update({
          credits: (currentCredits.credits || 0) + credits,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId);
    } else {
      await supabase.from('user_credits').insert({
        user_id: userId,
        credits: credits,
      });
    }

    // Aussi mettre à jour users.credits pour compatibilité
    await supabase
      .from('users')
      .update({ credits: supabase.rpc('increment_credits', { user_id: userId, amount: credits }) })
      .eq('id', userId);

    // Rediriger vers l'app avec deep link
    const appSuccessUrl = process.env.GC_APP_SUCCESS_URL || 'resilienceapp://gc/success';
    res.redirect(appSuccessUrl);
  } catch (error) {
    console.error('[GC] Erreur callback:', error);
    res.status(500).send('Erreur lors du paiement');
  }
});

// Webhook PSP
app.post('/api/webhooks/psp', async (req, res) => {
  try {
    const { member_id, program_id, amount_cents, status } = req.body;

    if (status !== 'paid') return res.json({ ok: true });

    await supabase.from('purchases').insert({
      member_id, product_type: 'coaching_program', quantity: 1, amount_cents, status: 'paid'
    });

    const { data: prog } = await supabase
      .from('coach_programs')
      .select('videos')
      .eq('id', program_id)
      .single();

    const { data: existing } = await supabase
      .from('coach_enrollments')
      .select('program_id')
      .eq('program_id', program_id)
      .eq('member_id', member_id)
      .maybeSingle();

    if (!existing) {
      await supabase.from('coach_enrollments').insert({
        program_id, member_id,
        progress: 0, completed_sessions: 0, total_sessions: prog?.videos || 0
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Backend listening on :${PORT}`);
  console.log(`✅ Routes disponibles:`);
  console.log(`   GET  /api/health`);
  console.log(`   POST /api/reservations`);
  console.log(`   POST /api/coaching/checkout`);
  console.log(`   POST /gc/redirect-flow`);
  console.log(`   GET  /gc/success`);
  console.log(`   POST /api/webhooks/psp`);
});

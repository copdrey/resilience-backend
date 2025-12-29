require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PORT = 8080
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const app = express();

app.use(cors());
app.use(bodyParser.json());

// ✅ 1) Checkout coaching - CORRIGÉ
app.post('/api/coaching/checkout', async (req, res) => {
  try {
    const { member_id, program_id } = req.body;
    if (!member_id || !program_id) {
      return res.status(400).json({ error: 'member_id and program_id are required' });
    }

    console.log('[Coaching] Checkout request:', { member_id, program_id });

    // ✅ CORRECTION 1 : Bonne table + bons champs
    const { data: prog, error: pe } = await supabase
      .from('coaching_programs')  // ✅ Correct
      .select('id, price, title')  // ✅ Correct
      .eq('id', program_id)
      .single();

    if (pe || !prog) {
      console.error('[Coaching] Program not found:', pe);
      return res.status(400).json({ error: pe?.message || 'Program not found' });
    }

    console.log('[Coaching] Program found:', prog.title, prog.price);

    // ✅ CORRECTION 2 : Créer redirect GoCardless
    const amount = parseFloat(prog.price);
    const amountPence = Math.round(amount * 100);  // Convertir en centimes

    // Récupérer infos user
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', member_id)
      .single();

    console.log('[Coaching] User profile:', profile?.email);

    const sessionToken = `coaching_${member_id}_${Date.now()}`;

    const gcBody = {
      redirect_flows: {
        description: `Coaching ${prog.title}`,
        session_token: sessionToken,
        success_redirect_url: process.env.GC_SUCCESS_REDIRECT_URL || 'https://resilience-backend-production.up.railway.app/gc/success',
        scheme: 'sepa_core',
        prefilled_customer: {
          given_name: profile?.full_name?.split(' ')[0] || 'Client',
          family_name: profile?.full_name?.split(' ').slice(1).join(' ') || '',
          email: profile?.email || '',
        },
        metadata: {
          user_id: member_id,
          program_id: String(program_id),
          amount_pence: String(amountPence),  // ✅ En centimes0
        }
      }
    };

    console.log('[Coaching] Creating GoCardless flow...');

    const gcResponse = await fetch(`${process.env.GC_BASE || 'https://api.gocardless.com'}/redirect_flows`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GC_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(gcBody),
    });

    const gcData = await gcResponse.json();

    if (!gcResponse.ok) {
      console.error('[Coaching] GoCardless error:', JSON.stringify(gcData, null, 2));
      return res.status(500).json({ error: gcData.error?.message || 'Erreur GoCardless' });
    }

    console.log('[Coaching] Flow created:', gcData.redirect_flows.id);

    // ✅ CORRECTION 3 : Retourner redirectUrl
    return res.json({
      redirectUrl: gcData.redirect_flows.redirect_url,
      flowId: gcData.redirect_flows.id,
    });

  } catch (e) {
    console.error('[Coaching] Error:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});
// ====================================================================
// ROUTE : Achat de crédits direct (/api/purchase)
// À AJOUTER APRÈS la route /api/coaching/checkout (ligne ~117)
// ====================================================================
app.post('/api/purchase', async (req, res) => {
  try {
    const { member_id, credits, amount } = req.body;

    console.log('[Purchase] Request:', { member_id, credits, amount });

    if (!member_id || !credits || !amount) {
      return res.status(400).json({ error: 'Missing required fields: member_id, credits, amount' });
    }

    // Récupérer infos user
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', member_id)
      .single();

    console.log('[Purchase] User profile:', profile?.email);

    const sessionToken = `purchase_${member_id}_${Date.now()}`;
    const amountNum = parseFloat(amount);

    const gcBody = {
      redirect_flows: {
        description: `Achat ${credits} crédits - Résilience Studio`,
        session_token: sessionToken,
        success_redirect_url: process.env.GC_SUCCESS_REDIRECT_URL || 'https://resilience-backend-production.up.railway.app/gc/success',
        scheme: 'sepa_core',
        prefilled_customer: {
          given_name: profile?.full_name?.split(' ')[0] || 'Client',
          family_name: profile?.full_name?.split(' ').slice(1).join(' ') || '',
          email: profile?.email || '',
        },
        metadata: {
          user_id: member_id,
          credits: String(credits),
          amount: String(amountNum),
        },
      }
    };

    console.log('[Purchase] Creating GoCardless flow...');

    const gcResponse = await fetch(`${process.env.GC_BASE || 'https://api.gocardless.com'}/redirect_flows`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GC_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(gcBody),
    });

    const gcData = await gcResponse.json();

    if (!gcResponse.ok) {
      console.error('[Purchase] GoCardless error:', JSON.stringify(gcData, null, 2));
      return res.status(500).json({ error: gcData.error?.message || 'Erreur GoCardless' });
    }

    console.log('[Purchase] Flow created:', gcData.redirect_flows.id);

    return res.json({
      redirectUrl: gcData.redirect_flows.redirect_url,
      flowId: gcData.redirect_flows.id,
    });

  } catch (error) {
    console.error('[Purchase] Error:', error);
    res.status(500).json({ error: error.message });
  }
});
// Route pour créer un redirect flow GoCardless (crédits)
app.post('/gc/redirect-flow', async (req, res) => {
  try {
    const { sessionToken, amount, description, metadata = {} } = req.body;

    if (!sessionToken || !amount || !description) {
      return res.status(400).json({ error: 'Paramètres manquants' });
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }

    const gcBody = {
      redirect_flows: {
        description: String(description),
        session_token: String(sessionToken),
        success_redirect_url: process.env.GC_SUCCESS_REDIRECT_URL || 'https://resilience-backend-production.up.railway.app/gc/success',
        scheme: 'sepa_core',
      }
    };

    if (metadata.userName || metadata.userEmail) {
      const nameParts = metadata.userName ? String(metadata.userName).trim().split(' ') : ['Client'];

      gcBody.redirect_flows.prefilled_customer = {
        given_name: nameParts[0] || 'Client',
      };

      if (nameParts.length > 1) {
        gcBody.redirect_flows.prefilled_customer.family_name = nameParts.slice(1).join(' ');
      }

      if (metadata.userEmail) {
        gcBody.redirect_flows.prefilled_customer.email = String(metadata.userEmail);
      }
    }

    if (metadata.userId) {
      gcBody.redirect_flows.metadata = {
        user_id: String(metadata.userId),
        credits: String(metadata.credits || '0'),
        amount: String(amountNum),
        product_type: 'credits',
      };
    }

    console.log('[GC] Body envoyé:', JSON.stringify(gcBody, null, 2));

    const gcResponse = await fetch(`${process.env.GC_BASE || 'https://api.gocardless.com'}/redirect_flows`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GC_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(gcBody),
    });

    const data = await gcResponse.json();

    if (!gcResponse.ok) {
      console.error('[GC] Erreur GoCardless:', JSON.stringify(data, null, 2));
      throw new Error(data.error?.message || 'Erreur GoCardless');
    }

    console.log('[GC] Flow créé:', data.redirect_flows.id);

    res.json({
      redirectUrl: data.redirect_flows.redirect_url,
      flowId: data.redirect_flows.id,
    });
  } catch (error) {
    console.error('[GC] Erreur:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Route callback GoCardless - CORRIGÉE
app.get('/gc/success', async (req, res) => {
  try {
    const { redirect_flow_id, session_token } = req.query;

    console.log('[GC] Success callback:', { redirect_flow_id, session_token });

    if (!redirect_flow_id) {
      return res.status(400).send('Missing redirect_flow_id');
    }

    const completeFlow = await fetch(
      `${process.env.GC_BASE || 'https://api.gocardless.com'}/redirect_flows/${redirect_flow_id}/actions/complete`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GC_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: {
            session_token: session_token || '',
          },
        }),
      }
    );

    const flowData = await completeFlow.json();

    if (!completeFlow.ok) {
      console.error('[GC] Error completing flow:', flowData);
      throw new Error('Erreur completion flow: ' + JSON.stringify(flowData));
    }

    console.log('[GC] Flow completed:', flowData);

    const metadata = flowData.redirect_flows?.metadata || {};
    const userId = metadata.user_id;
    const programId = metadata.program_id;
    const productType = programId ? 'coaching' : 'credits';0

    if (!userId) {
      console.error('[GC] No userId in metadata');
      return res.status(400).send('Missing userId in flow metadata');
    }

    const mandateId = flowData.redirect_flows.links.mandate;

    // ✅ GESTION COACHING
    if (productType === 'coaching') {
      console.log('[GC] Processing coaching purchase...');

      const programId = parseInt(metadata.program_id);
      const amountPence = parseInt(metadata.amount_pence || metadata.amount * 100);

      const paymentBody = {
        payments: {
          amount: amountPence,
          currency: 'EUR',
          links: {
            mandate: mandateId,
          },
          metadata: {
            user_id: userId,
            program_id: String(programId),
            product_type: 'coaching',
          },
          description: `Coaching programme ${programId}`,
        }
      };

      console.log('[GC] Creating payment...', paymentBody.payments.amount);

      const paymentResponse = await fetch(
        `${process.env.GC_BASE || 'https://api.gocardless.com'}/payments`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GC_ACCESS_TOKEN}`,
            'GoCardless-Version': '2015-07-06',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(paymentBody),
        }
      );

      const paymentData = await paymentResponse.json();

      if (!paymentResponse.ok) {
        console.error('[GC] Payment creation error:', paymentData);
        throw new Error('Erreur création paiement');
      }

      console.log('[GC] Payment created:', paymentData.payments.id);

      await supabase.from('purchases').insert({
        member_id: userId,
        product_type: 'coaching_program',
        quantity: 1,
        amount_cents: amountPence,
        status: 'pending',
        transaction_id: paymentData.payments.id,
      });

      const { data: prog } = await supabase
        .from('coaching_programs')
        .select('sessions')
        .eq('id', programId)
        .single();

      const { data: existing } = await supabase
        .from('coach_enrollments')
        .select('program_id')
        .eq('program_id', programId)
        .eq('member_id', userId)
        .maybeSingle();

      if (!existing) {
        await supabase.from('coach_enrollments').insert({
          program_id: programId,
          member_id: userId,
          progress: 0,
          completed_sessions: 0,
          total_sessions: parseInt(prog?.sessions) || 0,
        });
      }

      console.log('[GC] Coaching enrollment created');

      const appSuccessUrl = process.env.GC_APP_SUCCESS_URL || 'resilienceapp://gc/success';
      return res.redirect(appSuccessUrl);
    }

    // ✅ GESTION CRÉDITS
    const credits = parseInt(metadata.credits || '0');
    const amount = parseFloat(metadata.amount || '0');

    const { error: purchaseError } = await supabase
      .from('credit_purchases')
      .insert({
        user_id: userId,
        amount: amount,
        credits_quantity: credits,
        payment_status: 'completed',
        payment_method: 'gocardless',
        transaction_id: flowData.redirect_flows.id,
        notes: `GoCardless payment - ${credits} crédits`,
      });

    if (purchaseError) {
      console.error('[GC] Error creating purchase:', purchaseError);
      throw purchaseError;
    }

    const { data: currentCredits } = await supabase
      .from('user_credits')
      .select('credits_remaining, total_purchased')
      .eq('user_id', userId)
      .maybeSingle();

    if (currentCredits) {
      await supabase
        .from('user_credits')
        .update({
          credits_remaining: (currentCredits.credits_remaining || 0) + credits,
          total_purchased: (currentCredits.total_purchased || 0) + credits,
        })
        .eq('user_id', userId);
    } else {
      await supabase.from('user_credits').insert({
        user_id: userId,
        credits_remaining: credits,
        total_purchased: credits,
      });
    }

    console.log('[GC] Credits updated for user:', userId);

    const appSuccessUrl = process.env.GC_APP_SUCCESS_URL || 'resilienceapp://gc/success';
    res.redirect(appSuccessUrl);
  } catch (error) {
    console.error('[GC] Erreur callback:', error);
    res.status(500).send('Erreur lors du paiement: ' + error.message);
  }
});

// Webhook GoCardless
app.post('/gc/webhook', async (req, res) => {
  try {
    const events = req.body.events || [];
    console.log('[GC] Webhook received:', events.length, 'events');

    for (const event of events) {
      console.log('[GC] Processing event:', event.resource_type, event.action);

      if (event.resource_type === 'payments' && event.action === 'confirmed') {
        const paymentId = event.links.payment;

        const paymentResponse = await fetch(
          `${process.env.GC_BASE || 'https://api.gocardless.com'}/payments/${paymentId}`,
          {
            headers: {
              'Authorization': `Bearer ${process.env.GC_ACCESS_TOKEN}`,
              'GoCardless-Version': '2015-07-06',
            },
          }
        );

        const paymentData = await paymentResponse.json();
        console.log('[GC] Payment data:', paymentData);

        const metadata = paymentData.payments?.metadata || {};

        if (metadata.product_type === 'coaching') {
          await supabase
            .from('purchases')
            .update({ status: 'paid' })
            .eq('transaction_id', paymentId);
          console.log('[GC] Coaching purchase confirmed:', paymentId);
        } else if (metadata.user_id) {
          await supabase
            .from('credit_purchases')
            .update({ payment_status: 'completed' })
            .eq('transaction_id', paymentId);
        }
      }

      if (event.resource_type === 'payments' && event.action === 'failed') {
        const paymentId = event.links.payment;
        await supabase
          .from('credit_purchases')
          .update({ payment_status: 'failed' })
          .eq('transaction_id', paymentId);
        await supabase
          .from('purchases')
          .update({ status: 'failed' })
          .eq('transaction_id', paymentId);
        console.log('[GC] Payment failed:', paymentId);
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[GC] Webhook error:', error);
    res.status(500).json({ error: error.message });
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
      .from('coaching_programs')
      .select('sessions')
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
        progress: 0, completed_sessions: 0, total_sessions: parseInt(prog?.sessions) || 0
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// Route réservation cours
app.post('/courses/:courseId/enroll', async (req, res) => {
  try {
    const { courseId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId requis' });
    }

    const { data: credits, error: creditsError } = await supabase
      .from('user_credits')
      .select('credits_remaining')
      .eq('user_id', userId)
      .single();

    if (creditsError || !credits || credits.credits_remaining < 1) {
      return res.status(400).json({ error: 'Crédits insuffisants' });
    }

    const { data: reservation, error: reservationError } = await supabase
      .from('reservations')
      .insert({
        user_id: userId,
        course_id: parseInt(courseId),
        status: 'confirmed',
        reserved_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (reservationError) throw reservationError;

    const { error: updateError } = await supabase
      .from('user_credits')
      .update({ credits_remaining: credits.credits_remaining - 1 })
      .eq('user_id', userId);

    if (updateError) throw updateError;

    res.json({
      success: true,
      reservation,
      creditsRemaining: credits.credits_remaining - 1
    });
  } catch (error) {
    console.error('[Enroll] Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test Supabase
app.get('/debug/supabase', async (req, res) => {
  try {
    const { count: userCount, error: userError } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true });

    if (userError) throw userError;

    const { count: courseCount, error: courseError } = await supabase
      .from('course_templates')
      .select('*', { count: 'exact', head: true });

    if (courseError) throw courseError;

    const { count: paymentCount, error: paymentError} = await supabase
      .from('credit_purchases')
      .select('*', { count: 'exact', head: true });

    if (paymentError) throw paymentError;

    res.json({
      status: 'ok',
      supabase: 'connected',
      counts: {
        users: userCount,
        courses: courseCount,
        payments: paymentCount,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Backend listening on :${PORT}`));

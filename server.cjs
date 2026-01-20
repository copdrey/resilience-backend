// ✅ CHARGER DOTENV EN PREMIER
require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 8080;

// ✅ MIDDLEWARES CRITIQUES
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ VÉRIFICATION DES VARIABLES
console.log('🚀 Starting Resilience Backend...');
console.log('📍 Environment:', process.env.NODE_ENV || 'development');
console.log('🔑 SUPABASE_URL:', process.env.SUPABASE_URL ? '✅ Set' : '❌ Missing');
console.log('🔑 SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ Set' : '❌ Missing');
console.log('🔑 GoCardless token:', process.env.GOCARDLESS_ACCESS_TOKEN ? '✅ Set' : '❌ Missing');

const requiredVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GOCARDLESS_ACCESS_TOKEN',
];

const missingVars = requiredVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('❌ Missing variables:', missingVars.join(', '));
  console.error('💡 Check your .env file in:', __dirname);
  process.exit(1);
}

console.log('✅ All required variables loaded');

// ✅ INITIALISER SUPABASE
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ========================================
// ROUTES
// ========================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.GOCARDLESS_ENVIRONMENT || 'live'
  });
});

// ========================================
// ROUTE D'ENRÔLEMENT (RÉSERVATION)
// ========================================
app.post('/courses/:courseId/enroll', async (req, res) => {
  console.log('==================== [ENROLL] START ====================');
  console.log('[ENROLL] Course ID:', req.params.courseId);
  console.log('[ENROLL] Body:', JSON.stringify(req.body, null, 2));

  try {
    const { courseId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }

    // 1. Vérifier les crédits de l'utilisateur
    const { data: userCredits, error: creditsError } = await supabase
      .from('user_credits')
      .select('credits_remaining')
      .eq('user_id', userId)
      .single();

    if (creditsError) {
      console.error('[ENROLL] Error fetching credits:', creditsError);
      return res.status(500).json({ error: 'Failed to check credits' });
    }

    if (!userCredits || userCredits.credits_remaining < 1) {
      return res.status(400).json({ error: 'Insufficient credits' });
    }

    // 2. Vérifier la capacité du cours
    const { data: course, error: courseError } = await supabase
      .from('course_templates')
      .select('capacity')
      .eq('id', courseId)
      .single();

    if (courseError) {
      console.error('[ENROLL] Error fetching course:', courseError);
      return res.status(500).json({ error: 'Course not found' });
    }

    // Compter les inscriptions confirmées
    const { count, error: countError } = await supabase
      .from('reservations')
      .select('*', { count: 'exact', head: true })
      .eq('course_id', courseId)
      .eq('status', 'confirmed');

    if (countError) {
      console.error('[ENROLL] Error counting enrollments:', countError);
      return res.status(500).json({ error: 'Failed to check capacity' });
    }

    if (count >= course.capacity) {
      return res.status(400).json({ error: 'Course is full' });
    }

    // 3. Créer la réservation
    const { data: reservation, error: reservationError } = await supabase
      .from('reservations')
      .insert({
        user_id: userId,
        course_id: courseId,
        status: 'confirmed',
        reserved_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (reservationError) {
      console.error('[ENROLL] Error creating reservation:', reservationError);
      return res.status(500).json({ error: 'Failed to create reservation' });
    }

    // 4. Déduire 1 crédit
    const { error: deductError } = await supabase
      .from('user_credits')
      .update({ credits_remaining: userCredits.credits_remaining - 1 })
      .eq('user_id', userId);

    if (deductError) {
      console.error('[ENROLL] Error deducting credit:', deductError);
      // Annuler la réservation si le débit échoue
      await supabase.from('reservations').delete().eq('id', reservation.id);
      return res.status(500).json({ error: 'Failed to deduct credit' });
    }

    console.log('[ENROLL] Success! Reservation:', reservation.id);
    res.json({
      success: true,
      reservation,
      remainingCredits: userCredits.credits_remaining - 1,
    });

  } catch (error) {
    console.error('[ENROLL] Exception:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// GOCARDLESS - REDIRECT FLOW
// ========================================
app.post('/gc/redirect-flow', async (req, res) => {
  console.log('==================== [GC] START ====================');
  console.log('[GC] Body:', JSON.stringify(req.body, null, 2));

  try {
    const { sessionToken, amount, description, metadata } = req.body;

    if (!sessionToken) throw new Error('sessionToken required');
    if (!metadata?.userId) throw new Error('metadata.userId required');

    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'https://resilience-backend-production.up.railway.app';
    const successUrl = `${baseUrl}/gc/success?user=${metadata.userId}&credits=${metadata.credits || 0}&session=${sessionToken}`;

    const payload = {
      redirect_flows: {
        description: description || 'Achat de crédits',
        session_token: sessionToken,
        success_redirect_url: successUrl,
        prefilled_customer: {
          email: metadata.userEmail || 'noreply@resilience.com'
        }
      }
    };

    console.log('[GC] Sending to GoCardless:', JSON.stringify(payload, null, 2));

    const gcResponse = await fetch('https://api.gocardless.com/redirect_flows', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const gcData = await gcResponse.json();

    console.log('[GC] GoCardless status:', gcResponse.status);
    console.log('[GC] GoCardless response:', JSON.stringify(gcData, null, 2));

    if (!gcResponse.ok) {
      return res.status(gcResponse.status).json(gcData);
    }

    res.json(gcData);

  } catch (error) {
    console.error('[GC] Exception:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// GOCARDLESS - SUCCESS
// ========================================
app.get('/gc/success', async (req, res) => {
  console.log('[GC Success] Query:', req.query);

  const { redirect_flow_id, user, credits, session } = req.query;

  if (!redirect_flow_id) {
    return res.status(400).send('Missing redirect_flow_id');
  }

  try {
    // Compléter le redirect flow
    const completeResponse = await fetch(
      `https://api.gocardless.com/redirect_flows/${redirect_flow_id}/actions/complete`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ data: { session_token: session } })
      }
    );

    const completeData = await completeResponse.json();
    console.log('[GC Success] Complete response:', completeData);

    // Ajouter les crédits dans Supabase
    if (user && credits) {
      const { data: currentCredits } = await supabase
        .from('user_credits')
        .select('credits_remaining')
        .eq('user_id', user)
        .single();

      const newTotal = (currentCredits?.credits_remaining || 0) + parseInt(credits);

      await supabase
        .from('user_credits')
        .upsert({
          user_id: user,
          credits_remaining: newTotal,
        });

      console.log('[GC Success] Credits added:', credits, 'New total:', newTotal);
    }

    // Redirection vers l'app
    res.redirect(`resilienceapp://payment-success?credits=${credits || 0}`);

  } catch (error) {
    console.error('[GC Success] Error:', error);
    res.redirect(`resilienceapp://payment-error?message=${encodeURIComponent(error.message)}`);
  }
});

// ========================================
// DÉMARRAGE
// ========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on :${PORT}`);
  console.log('✅ Routes disponibles:');
  console.log('   GET  /api/health');
  console.log('   POST /courses/:id/enroll');
  console.log('   POST /gc/redirect-flow');
  console.log('   GET  /gc/success');
});

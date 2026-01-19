// ✅ CHARGER DOTENV EN PREMIER
require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// ✅ VÉRIFICATION APRÈS CHARGEMENT
console.log('🚀 Starting Resilience Backend...');
console.log('📍 Environment:', process.env.NODE_ENV || 'development');
console.log('🔑 SUPABASE_URL:', process.env.SUPABASE_URL ? '✅ Set' : '❌ Missing');
console.log('🔑 SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ Set' : '❌ Missing');
console.log('🔑 GoCardless token:', process.env.GOCARDLESS_ACCESS_TOKEN ? '✅ Set' : '❌ Missing');

// ✅ ARRÊT SI VARIABLES MANQUANTES
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.GOCARDLESS_ENVIRONMENT || 'live'
  });
});

// ✅ ROUTE REDIRECT FLOW SIMPLIFIÉE
app.post('/gc/redirect-flow', async (req, res) => {
  console.log('==================== [GC] START ====================');
  console.log('[GC] Body:', JSON.stringify(req.body, null, 2));
  console.log('[GC] Token exists:', !!process.env.GOCARDLESS_ACCESS_TOKEN);
  console.log('====================================================');

  try {
    const { sessionToken, amount, description, metadata } = req.body;

    // Validation
    if (!sessionToken) throw new Error('sessionToken required');
    if (!metadata?.userId) throw new Error('metadata.userId required');

    // URL de succès
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://resilience-backend-production.up.railway.app';
    const successUrl = `${baseUrl}/gc/success?user=${metadata.userId}&credits=${metadata.credits || 0}&session=${sessionToken}`;

    console.log('[GC] Success URL:', successUrl);

    // Payload GoCardless
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

    // Appel GoCardless
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
    console.error('[GC] ❌ Exception:', error.message);
    console.error('[GC] ❌ Stack:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

// ✅ ROUTE SUCCESS
app.get('/gc/success', async (req, res) => {
  console.log('[GC Success] Query:', req.query);

  const { redirect_flow_id, user, credits, session } = req.query;

  if (!redirect_flow_id) {
    return res.status(400).send('Missing redirect_flow_id');
  }

  try {
    // Compléter le redirect flow
    const completeResponse = await fetch(`https://api.gocardless.com/redirect_flows/${redirect_flow_id}/actions/complete`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
        'GoCardless-Version': '2015-07-06',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: { session_token: session } })
    });

    const completeData = await completeResponse.json();
    console.log('[GC Success] Complete response:', completeData);

    // TODO: Ajouter les crédits dans Supabase ici

    // Redirection vers l'app
    res.redirect(`resilienceapp://payment-success?credits=${credits || 0}`);

  } catch (error) {
    console.error('[GC Success] Error:', error);
    res.redirect(`resilienceapp://payment-error?message=${encodeURIComponent(error.message)}`);
  }
});

// Démarrage
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on :${PORT}`);
  console.log('✅ Routes disponibles:');
  console.log('   GET  /api/health');
  console.log('   POST /gc/redirect-flow');
  console.log('   GET  /gc/success');
});

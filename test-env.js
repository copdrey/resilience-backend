require('dotenv').config();

console.log('=== TEST DOTENV ===');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL || '❌ MISSING');
console.log('SERVICE_ROLE:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ LOADED' : '❌ MISSING');
console.log('GOCARDLESS:', process.env.GOCARDLESS_ACCESS_TOKEN ? '✅ LOADED' : '❌ MISSING');

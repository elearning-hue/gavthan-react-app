// ============================================================================
// config-init.js — populate window.GH_CONFIG / window.GH_ADMINS from Vite env.
//
// app.js imports this at the very top, so it runs before app.js evaluates its
// own top-level config consts (SUPABASE_URL, ADMIN_EMAILS, the supabase client).
// Vite only exposes vars prefixed with VITE_ to client code. See .env.example.
// ============================================================================
const env = import.meta.env;

window.GH_CONFIG = {
  supabaseUrl:     env.VITE_SUPABASE_URL || '',
  supabaseKey:     env.VITE_SUPABASE_ANON_KEY || '',
  upiId:           env.VITE_UPI_ID || '',
  hotelName:       env.VITE_HOTEL_NAME || 'Gavthan',
  partnerDiscount: Number(env.VITE_PARTNER_DISCOUNT) || 0,
  googleClientId:  env.VITE_GOOGLE_CLIENT_ID || '',
};

window.GH_ADMINS = (env.VITE_ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

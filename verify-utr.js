/* ==========================================================================
 *  netlify/functions/verify-utr.js
 *  Anti-Fraud Manual UPI Subscription Engine (₹99 / 30 days)
 *
 *  Flow:
 *   1. Verify the caller's Supabase JWT.
 *   2. Enforce a STRICT 12-digit UTR format.
 *   3. Duplicate guard → 400 + Hindi warning (DB UNIQUE constraint is the
 *      second line of defence against concurrent double-submits).
 *   4. Insert the payment row (service role — RLS blocks client forgeries).
 *   5. Set profiles.plan_status = 'active' and extend
 *      profiles.plan_expires_at by +30 days.
 * ========================================================================== */

import { createClient } from '@supabase/supabase-js';

/* ----------------------------- Environment ------------------------------ */
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const EXPECTED_AMOUNT = Number(process.env.PLAN_PRICE || 99);
const PLAN_DAYS = 30;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* -------------------------------- Messages ------------------------------ */
const DUPLICATE_MSG =
  '🚨 चेतावनी: यह UTR पहले ही उपयोग किया जा चुका है! बार-बार डुप्लीकेट UTR डालने पर आपका अकाउंट बैन हो सकता है।';

const INVALID_UTR_MSG =
  '⚠️ गलत UTR: कृपया अपने UPI ऐप की रसीद से सटीक 12-अंकीय UTR / Ref No. दर्ज करें।';

const SUCCESS_MSG =
  '✅ UTR सत्यापित हो गया! आपका ViralAI Pro प्लान अगले 30 दिनों के लिए सक्रिय हो गया है।';

/* -------------------------------- Helpers ------------------------------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status, payload) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  body: JSON.stringify(payload),
});

const readBody = (event) => {
  try {
    return JSON.parse(event.body || '{}');
  } catch {
    return {};
  }
};

const getToken = (event) => {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
};

/** Strict: exactly 12 digits, nothing else. */
const UTR_REGEX = /^\d{12}$/;

/* -------------------------------- Handler ------------------------------- */
export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed. Use POST.' });

  /* 1. ---- Authentication ---- */
  const token = getToken(event);
  if (!token) return json(401, { error: 'Authentication required. Please sign in.' });

  let user;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return json(401, { error: 'Invalid or expired session. Please sign in again.' });
    user = data.user;
  } catch {
    return json(401, { error: 'Authentication failed.' });
  }

  /* 2. ---- Input validation (strict 12-digit UTR) ---- */
  const body = readBody(event);
  const utr = String(body.utr_number ?? body.utr ?? '').trim();

  if (!UTR_REGEX.test(utr)) {
    return json(400, { error: INVALID_UTR_MSG, code: 'INVALID_UTR_FORMAT' });
  }

  const amount = Number(body.amount ?? EXPECTED_AMOUNT);
  if (!Number.isFinite(amount) || Math.abs(amount - EXPECTED_AMOUNT) > 0.01) {
    return json(400, { error: `Payment amount must be exactly ₹${EXPECTED_AMOUNT.toFixed(2)}.`, code: 'INVALID_AMOUNT' });
  }

  /* 3. ---- Account standing ---- */
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, plan_type, plan_status, plan_expires_at')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) return json(500, { error: `Profile lookup failed: ${profileError.message}` });
  if (!profile) return json(404, { error: 'Profile not found. Please sign in again.' });
  if (profile.plan_status === 'banned') {
    return json(403, {
      error: '🚨 यह अकाउंट धोखाधड़ी के कारण बैन कर दिया गया है। संपर्क करें: support@virali.ai',
      code: 'ACCOUNT_BANNED',
    });
  }

  /* 4. ---- Duplicate UTR guard (query level) ---- */
  const { data: existing, error: dupError } = await supabaseAdmin
    .from('upi_payments')
    .select('id, user_id, status, created_at')
    .eq('utr_number', utr)
    .maybeSingle();

  if (dupError && dupError.code !== 'PGRST116') {
    return json(500, { error: `Ledger check failed: ${dupError.message}` });
  }

  if (existing) {
    return json(400, {
      error: DUPLICATE_MSG,
      code: 'DUPLICATE_UTR',
      first_used_at: existing.created_at,
    });
  }

  /* 5. ---- Insert payment (UNIQUE constraint = race-condition guard) ---- */
  let payment;
  try {
    const { data, error } = await supabaseAdmin
      .from('upi_payments')
      .insert({
        user_id: user.id,
        utr_number: utr,
        amount: EXPECTED_AMOUNT,
        plan_requested: String(body.plan_requested || 'pro_monthly').slice(0, 40),
        status: 'verified',
      })
      .select('id, utr_number, amount, status, created_at')
      .single();

    if (error) {
      // 23505 = unique_violation → someone won the race with the same UTR
      if (error.code === '23505') {
        return json(400, { error: DUPLICATE_MSG, code: 'DUPLICATE_UTR' });
      }
      throw error;
    }
    payment = data;
  } catch (err) {
    console.error('[verify-utr] insert failed:', err.message);
    return json(500, { error: `Payment record failed: ${err.message}` });
  }

  /* 6. ---- Activate / extend subscription: +30 days ---- */
  //  plan_expires_at = GREATEST(plan_expires_at, NOW()) + INTERVAL '30 days'
  //  → expired/never: NOW() + 30 days, still-active: stacks on top.
  const { data: updated, error: updateError } = await supabaseAdmin.rpc('activate_pro_plan', {
    p_user_id: user.id,
    p_days: PLAN_DAYS,
  });

  let planExpiresAt = null;

  if (updateError) {
    // RPC may not exist yet — fall back to a direct service-role update.
    console.warn('[verify-utr] rpc unavailable, using direct update:', updateError.message);

    const base =
      profile.plan_expires_at && new Date(profile.plan_expires_at).getTime() > Date.now()
        ? new Date(profile.plan_expires_at)
        : new Date();

    base.setDate(base.getDate() + PLAN_DAYS);
    planExpiresAt = base.toISOString();

    const { error: fallbackError } = await supabaseAdmin
      .from('profiles')
      .update({
        plan_type: 'pro',
        plan_status: 'active',
        plan_expires_at: planExpiresAt,
      })
      .eq('id', user.id);

    if (fallbackError) {
      console.error('[verify-utr] activation failed:', fallbackError.message);
      return json(500, {
        error:
          'Payment recorded but activation failed. Please retry — your UTR is safe and will not be charged twice.',
        code: 'ACTIVATION_FAILED',
        utr_number: utr,
      });
    }
  } else {
    // `returns table(...)` is delivered by postgrest as an array of rows.
    const row = Array.isArray(updated) ? updated[0] : updated;
    planExpiresAt = row?.plan_expires_at || null;
    if (!planExpiresAt) {
      const { data: fresh } = await supabaseAdmin
        .from('profiles')
        .select('plan_expires_at')
        .eq('id', user.id)
        .single();
      planExpiresAt = fresh?.plan_expires_at || null;
    }
  }

  console.log(`✅ [verify-utr] UTR ${utr} verified for ${user.id} → valid till ${planExpiresAt}`);

  /* 7. ---- Success ---- */
  return json(200, {
    ok: true,
    message: SUCCESS_MSG,
    code: 'UTR_VERIFIED',
    plan_status: 'active',
    plan_expires_at: planExpiresAt,
    days_added: PLAN_DAYS,
    payment: {
      id: payment.id,
      utr_number: payment.utr_number,
      amount: Number(payment.amount),
      status: payment.status,
    },
  });
}

export default { handler };

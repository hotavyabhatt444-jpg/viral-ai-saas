/* ==========================================================================
 *  ViralAI SaaS — config.js
 *  Supabase bootstrap, shared constants and API transport helpers.
 *  Every value below can be overridden at runtime via window.VIRALAI_CONFIG
 *  (useful for Netlify Deploy Previews) or by editing the constants.
 * ========================================================================== */

import { createClient } from '@supabase/supabase-js';

/* ----------------------------- Runtime config ---------------------------- */
const RUNTIME = (typeof window !== 'undefined' && window.VIRALAI_CONFIG) || {};

export const CONFIG = Object.freeze({
  SUPABASE_URL:
    RUNTIME.SUPABASE_URL ||
    'https://https://xgouzwsizeuzdxvagkts.supabase.co',                       // <-- replace

  SUPABASE_ANON_KEY:
    RUNTIME.SUPABASE_ANON_KEY ||
    sb_publishable_uY6wxhOOUEpPMd0d7Jp2ww_1ek1hLLS

  /** Netlify Serverless Functions base path */
  FUNCTIONS_BASE: '/.netlify/functions',

  /** Hard-coded payment payload (must match the ₹99 Pro plan) */
  UPI: Object.freeze({
    PA: '6377121998-2@ybl',
    PN: 'ViralAISaaS',
    AM: '99.00',
    CU: 'INR',
    TN: 'ViralAI SaaS Pro - 30 Days',
  }),

  /** Subscription length enforced by the backend too */
  PLAN_DAYS: 30,
  PLAN_PRICE: 99,

  /** Grace period used only for the client-side lock animation */
  TICK_MS: 30_000,
});

/* --------------------------- Canonical UPI string ------------------------ */
/** upi://pay?pa=6377121998-2@ybl&pn=ViralAISaaS&am=99.00&cu=INR */
export const UPI_DEEPLINK =
  `upi://pay?pa=${encodeURIComponent(CONFIG.UPI.PA)}` +
  `&pn=${encodeURIComponent(CONFIG.UPI.PN)}` +
  `&am=${CONFIG.UPI.AM}` +
  `&cu=${CONFIG.UPI.CU}`;

/** Fallback intent used by the "Pay with UPI App" web link */
export const UPI_WEB_LINK =
  https://www.upilinks.in/payment-link/upi159695497` +
  `&pn=${CONFIG.UPI.PN}` +
  `&am=${CONFIG.UPI.AM}` +
  `&cu=${CONFIG.UPI.CU}` +
  `&tn=${encodeURIComponent(CONFIG.UPI.TN)}`;

/* ------------------------------- Supabase -------------------------------- */
export const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'virali-saas-auth',
  },
});

/* --------------------------- Transport helpers --------------------------- */

/** Resolve a serverless function endpoint. */
export const fn = (name) => `${CONFIG.FUNCTIONS_BASE}/${name}`;

/**
 * Call a Netlify Function with the caller's Supabase access token.
 * @param {string} name  function file name (without .js)
 * @param {object} body  JSON payload
 * @param {string} token Supabase JWT
 * @returns {Promise<{ok:boolean,status:number,data:any}>}
 */
export async function callFunction(name, body, token) {
  let res;
  try {
    res = await fetch(fn(name), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    return { ok: false, status: 0, data: { error: `Network error: ${err.message}` } };
  }

  const contentType = res.headers?.get?.('content-type') || '';

  // Safety net: if the catch-all SPA rewrite answered instead of the function,
  // surface an actionable message instead of a silent JSON parse failure.
  if (contentType.includes('text/html')) {
    return {
      ok: false,
      status: res.status,
      data: {
        error:
          'Serverless function not reached (the SPA shell answered instead). ' +
          'Check the Netlify function deployment & publish settings.',
      },
    };
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = { error: 'Malformed server response.' };
  }
  return { ok: res.ok, status: res.status, data };
}

/* ------------------------------- Utilities ------------------------------- */

/** Small DOM query shorthand. */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escape untrusted text before injecting into innerHTML. */
export const escapeHTML = (value = '') =>
  String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));

/** Copy text to clipboard with a legacy fallback. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
}

/** Human readable date formatting (IST-friendly, locale aware). */
export function formatDate(value, withTime = false) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

/** Is the plan valid right now? (mirrors `plan_expires_at > NOW()`) */
export function isPlanActive(profile) {
  if (!profile) return false;
  if (profile.plan_status !== 'active') return false;
  if (!profile.plan_expires_at) return false;
  return new Date(profile.plan_expires_at).getTime() > Date.now();
}

/** Seconds remaining on the plan (0 when expired). */
export function planSecondsLeft(profile) {
  if (!isPlanActive(profile)) return 0;
  return Math.floor((new Date(profile.plan_expires_at).getTime() - Date.now()) / 1000);
}

export default { CONFIG, supabase, callFunction, UPI_DEEPLINK, UPI_WEB_LINK };

/* ==========================================================================
 *  netlify/functions/generate-ai.js
 *  Secure AI proxy — validates the Supabase JWT, enforces an ACTIVE
 *  subscription (`plan_expires_at > NOW()`), rate-limits, forwards the prompt
 *  to OpenRouter (Gemini fallback) and persists the output.
 * ========================================================================== */

import { createClient } from '@supabase/supabase-js';

/* ----------------------------- Environment ------------------------------ */
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('⚠️  [generate-ai] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.');
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* ------------------------------ Rate limiter ---------------------------- */
const WINDOW_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 20;
const buckets = new Map();

function rateLimited(userId) {
  const now = Date.now();
  const bucket = buckets.get(userId);
  if (!bucket || now - bucket.start > WINDOW_MS) {
    buckets.set(userId, { start: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  if (buckets.size > 5000) buckets.clear(); // memory guard
  return bucket.count > MAX_REQUESTS;
}

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

/** Deeply defensive JSON extraction (models sometimes wrap output in prose). */
function parseModelJSON(text) {
  if (!text) return null;
  const trimmed = String(text).trim();

  const direct = trimmed.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(direct); } catch { /* continue */ }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { /* continue */ }
  }

  const arrFirst = trimmed.indexOf('[');
  const arrLast = trimmed.lastIndexOf(']');
  if (arrFirst !== -1 && arrLast > arrFirst) {
    try { return JSON.parse(trimmed.slice(arrFirst, arrLast + 1)); } catch { /* continue */ }
  }
  return null;
}

/* --------------------------- Prompt blueprints -------------------------- */
const PROMPTS = {
  hook: ({ topic, tone, platform }) => ({
    system:
      'You are ViralAI, a world-class short-form video hook strategist who has written hooks for 2,000+ creator channels. ' +
      'You ONLY return valid minified JSON. No markdown, no commentary.',
    user: `Write exactly 5 high-retention viral hooks for a short-form video.

TOPIC / NICHE: ${topic}
TONE: ${tone}
PLATFORM: ${platform}

Rules:
- Each hook must create an open loop, challenge an assumption, or promise a specific outcome.
- 6–18 words each, conversational, no hashtags, no emoji spam.
- Each hook gets a short "angle" label (e.g. "Contrarian", "Mistake Callout", "Result First").

Return EXACTLY this JSON shape:
{"hooks":[{"hook":"...","angle":"..."},{"hook":"...","angle":"..."},{"hook":"...","angle":"..."},{"hook":"...","angle":"..."},{"hook":"...","angle":"..."}]}`,
  }),

  script: ({ subject, length, tone }) => ({
    system:
      'You are ViralAI, a viral reel scriptwriter for creators and agencies. ' +
      'You ONLY return valid minified JSON. No markdown, no commentary.',
    user: `Write a complete 3-part short-form video script.

VIDEO SUBJECT: ${subject}
TARGET LENGTH: ${length}
TONE: ${tone}

Structure:
1) HOOK — first 1–3 seconds, pattern interrupt, no greetings.
2) BODY — dense, scannable value delivered in spoken language, short sentences, visual b-roll cues in [brackets] where useful.
3) CTA — one clear, low-friction call to action.

Return EXACTLY this JSON shape:
{"title":"...","hook":"...","body":"...","cta":"...","estimated_duration":"60 seconds","word_count":150}`,
  }),

  caption: ({ topic, platform, keyword }) => ({
    system:
      'You are ViralAI, an SEO caption and hashtag specialist for creators and agencies. ' +
      'You ONLY return valid minified JSON. No markdown, no commentary.',
    user: `Create an SEO-optimised caption for a short-form video.

VIDEO TOPIC: ${topic}
PLATFORM: ${platform}
FOCUS KEYWORD: ${keyword || 'auto-detect the best keyword'}

Rules:
- Caption: 2–4 short lines, first line is a scroll-stopping opener, includes 1 natural CTA, includes the focus keyword once naturally. No hashtags inside the caption.
- hashtags: 12–15 real, mixed-volume tags (3 broad, 7 niche, 3 long-tail), each starting with #.
- seo_keywords: 5 keyword phrases for the description/title.

Return EXACTLY this JSON shape:
{"caption":"...","hashtags":["#..."],"seo_keywords":["..."]}`,
  }),
};

/* --------------------------- Provider adapters -------------------------- */
async function callOpenRouter(system, user) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://virali-ai-saas.netlify.app',
      'X-Title': 'ViralAI SaaS',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      temperature: 0.9,
      max_tokens: 1600,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

async function callGemini(system, user) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent` +
    `?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 1600, responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
}

async function runModel(system, user) {
  if (OPENROUTER_API_KEY) return callOpenRouter(system, user);
  if (GEMINI_API_KEY) return callGemini(system, user);
  throw new Error('No AI provider key configured (set OPENROUTER_API_KEY).');
}

/* -------------------------------- Handler ------------------------------- */
export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed. Use POST.' });

  /* 1. ---- Auth ---- */
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

  /* 2. ---- Subscription gate: plan_expires_at > NOW() ---- */
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, plan_type, plan_status, plan_expires_at')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) return json(500, { error: `Profile lookup failed: ${profileError.message}` });

  const expiresAt = profile?.plan_expires_at ? new Date(profile.plan_expires_at).getTime() : 0;
  const isActive = profile?.plan_status === 'active' && expiresAt > Date.now();

  if (!isActive) {
    return json(402, {
      error: '🔒 आपका सब्सक्रिप्शन समाप्त हो गया है। कृपया ₹99 का भुगतान करके UTR सबमिट करें।',
      reason: 'subscription_inactive',
      plan_status: profile?.plan_status || 'unknown',
      plan_expires_at: profile?.plan_expires_at || null,
    });
  }

  /* 3. ---- Rate limit ---- */
  if (rateLimited(user.id)) {
    return json(429, { error: 'Too many AI requests. Please wait a few minutes and try again.' });
  }

  /* 4. ---- Input validation ---- */
  const body = readBody(event);
  const type = String(body.type || '').toLowerCase();

  if (!PROMPTS[type]) {
    return json(400, { error: 'Invalid generator type. Allowed: hook | script | caption.' });
  }

  const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const payload = { ...body };

  if (type === 'hook') {
    payload.topic = clean(body.topic, 200);
    payload.tone = clean(body.tone, 40) || 'bold';
    payload.platform = clean(body.platform, 40) || 'Instagram Reels';
    if (payload.topic.length < 3) return json(400, { error: 'Topic / niche is required.' });
  }

  if (type === 'script') {
    payload.subject = clean(body.subject, 600);
    payload.length = clean(body.length, 30) || '60 seconds';
    payload.tone = clean(body.tone, 40) || 'conversational';
    if (payload.subject.length < 8) return json(400, { error: 'Video subject is too short.' });
  }

  if (type === 'caption') {
    payload.topic = clean(body.topic, 400);
    payload.platform = clean(body.platform, 40) || 'Instagram';
    payload.keyword = clean(body.keyword, 80);
    if (payload.topic.length < 6) return json(400, { error: 'Video topic is too short.' });
  }

  /* 5. ---- Model call ---- */
  const { system, user: userPrompt } = PROMPTS[type](payload);

  let raw;
  try {
    raw = await runModel(system, userPrompt);
  } catch (err) {
    console.error('[generate-ai] provider error:', err.message);
    return json(502, { error: `AI provider error: ${err.message}` });
  }

  let result = parseModelJSON(raw);
  if (!result) {
    // Graceful degradation: never return a broken payload to the UI.
    if (type === 'hook') result = { hooks: [{ hook: String(raw).slice(0, 180), angle: 'Raw output' }] };
    else if (type === 'script') result = { hook: String(raw).slice(0, 400) };
    else result = { caption: String(raw).slice(0, 900), hashtags: [], seo_keywords: [] };
  }

  /* 6. ---- Persist history (RLS-protected table) ---- */
  try {
    await supabaseAdmin.from('generated_content').insert({
      user_id: user.id,
      type,
      input_prompt: userPrompt.slice(0, 4000),
      output_result: result,
    });
  } catch (err) {
    console.warn('[generate-ai] history insert skipped:', err.message);
  }

  return json(200, { ok: true, type, result, model: OPENROUTER_API_KEY ? OPENROUTER_MODEL : GEMINI_MODEL });
}

export default { handler };

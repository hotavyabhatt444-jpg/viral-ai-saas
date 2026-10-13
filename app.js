/* ==========================================================================
 *  ViralAI SaaS — app.js
 *  UI Navigation · Auth · AI Generation · Expiry/Lock Logic · UTR Verification
 *  Content Planner (Kanban) · Toasts
 * ========================================================================== */

import {
  CONFIG,
  supabase,
  callFunction,
  UPI_DEEPLINK,
  UPI_WEB_LINK,
  $,
  $$,
  escapeHTML,
  copyText,
  formatDate,
  isPlanActive,
} from './config.js';

/* -------------------------------- State ---------------------------------- */
const state = {
  session: null,
  profile: null,
  screen: 'hooks',
  lockDismissed: false,
  suppressLock: false,
  planner: [],
  lastHooks: [],
  lastScript: null,
  lastCaption: null,
  authMode: 'signin', // 'signin' | 'signup'
};

const SCREEN_META = {
  hooks:   { title: 'AI Hook Generator',        sub: '5 high-retention hooks, tuned to your tone.' },
  script:  { title: '3-Part Script Writer',     sub: 'Hook · Body · CTA — reel-ready in one click.' },
  caption: { title: 'Caption & SEO Studio',     sub: 'Search-optimised captions + viral hashtag stacks.' },
  planner: { title: 'Content Planner Calendar', sub: 'Idea → Scripted → Filmed → Posted.' },
  billing: { title: 'Pro Renewal · ₹99 / 30 Days', sub: 'UPI payment with manual 12-digit UTR verification.' },
};

/* ============================== TOASTS ================================== */
function toast(message, type = 'info') {
  const root = $('#toast-root');
  const icons = { info: 'ℹ️', success: '✅', error: '🚨' };
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.innerHTML =
    `<span class="toast__icon">${icons[type] || icons.info}</span>` +
    `<span class="toast__body">${escapeHTML(message)}</span>`;
  root.appendChild(el);

  const ttl = type === 'error' ? 7000 : 4000;
  setTimeout(() => {
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, ttl);
}

/* =========================== LOADING HELPERS ============================ */
function setLoading(btn, on, label) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.querySelector('.btn__label')?.textContent ?? '';
    const lbl = btn.querySelector('.btn__label');
    if (lbl) lbl.textContent = label || 'Working…';
    btn.classList.add('is-loading');
    btn.disabled = true;
  } else {
    const lbl = btn.querySelector('.btn__label');
    if (lbl && btn.dataset.label) lbl.textContent = btn.dataset.label;
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }
}

function showLoader(text) {
  $('#loader-text').textContent = text || 'Generating with AI…';
  $('#screen-loader').hidden = false;
}
function hideLoader() {
  $('#screen-loader').hidden = true;
}

function setFieldMessage({ errorEl, successEl, error = '', success = '' }) {
  if (errorEl) {
    errorEl.hidden = !error;
    errorEl.textContent = error;
  }
  if (successEl) {
    successEl.hidden = !success;
    successEl.textContent = success;
  }
}

/* ============================== NAVIGATION ============================== */
function navigate(screen) {
  if (!SCREEN_META[screen]) return;
  state.screen = screen;

  $$('.screen').forEach((s) => s.classList.toggle('is-active', s.dataset.screen === screen));
  $$('.nav-item, .tab').forEach((b) => b.classList.toggle('is-active', b.dataset.screen === screen));

  $('#screen-title').textContent = SCREEN_META[screen].title;
  $('#screen-subtitle').textContent = SCREEN_META[screen].sub;

  if (screen === 'planner') loadPlanner();
  if (screen === 'billing') { renderBilling(); loadPayments(); }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function bindNavigation() {
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-screen]');
    if (!trigger) return;
    navigate(trigger.dataset.screen);
  });
}

/* ================================ AUTH ================================== */
function paintAuthMode() {
  const isSignIn = state.authMode === 'signin';
  $('#auth-title').textContent = isSignIn ? 'Welcome back, Creator 👋' : 'Create your ViralAI account';
  $('#auth-subtitle').textContent = isSignIn
    ? 'Sign in to generate hooks, scripts, captions & plan your content calendar.'
    : 'Start with a 3-day free Pro trial — no card required.';
  $('#auth-submit').querySelector('.btn__label').textContent = isSignIn ? 'Sign In' : 'Create Account';
  $('#auth-toggle').innerHTML = isSignIn
    ? 'New here? <strong>Create an account</strong>'
    : 'Already registered? <strong>Sign in</strong>';
  $('#auth-password').setAttribute('autocomplete', isSignIn ? 'current-password' : 'new-password');
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const btn = $('#auth-submit');

  setFieldMessage({ errorEl: $('#auth-error') });

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return setFieldMessage({ errorEl: $('#auth-error'), error: 'Please enter a valid email address.' });
  }
  if (password.length < 6) {
    return setFieldMessage({ errorEl: $('#auth-error'), error: 'Password must be at least 6 characters.' });
  }

  setLoading(btn, true, 'Please wait…');

  try {
    const { data, error } =
      state.authMode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    if (error) throw error;

    if (state.authMode === 'signup' && !data.session) {
      setFieldMessage({
        errorEl: $('#auth-error'),
        error: 'Account created. Check your inbox to confirm, then sign in.',
      });
      state.authMode = 'signin';
      paintAuthMode();
      return;
    }

    setFieldMessage({ errorEl: $('#auth-error') });
    $('#auth-form').reset();
    toast(state.authMode === 'signin' ? 'Signed in successfully 🚀' : 'Account created — welcome aboard!', 'success');
  } catch (err) {
    setFieldMessage({ errorEl: $('#auth-error'), error: err.message || 'Authentication failed.' });
  } finally {
    setLoading(btn, false);
  }
}

async function signOut() {
  await supabase.auth.signOut();
  state.session = null;
  state.profile = null;
  $('#lock-overlay').hidden = true;
  $('#app-shell').hidden = true;
  $('#auth-screen').hidden = false;
  toast('Signed out. See you soon 👋');
}

/* =========================== PROFILE / ENTITLEMENT ====================== */
async function loadProfile() {
  if (!state.session) return null;
  const uid = state.session.user.id;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, plan_type, plan_status, plan_expires_at, created_at')
    .eq('id', uid)
    .maybeSingle();

  if (error) {
    console.warn('[profile]', error.message);
    return state.profile;
  }

  if (!data) {
    // First-login race: seed a row (RLS allows insert only if a policy exists;
    // the trigger normally creates it — this is a safe fallback).
    const { data: created } = await supabase
      .from('profiles')
      .insert({ id: uid, email: state.session.user.email, plan_type: 'free', plan_status: 'expired' })
      .select()
      .maybeSingle();
    state.profile = created;
  } else {
    state.profile = data;
  }

  paintProfileUI();
  enforceLock();
  return state.profile;
}

function paintProfileUI() {
  const p = state.profile;
  const active = isPlanActive(p);
  const email = p?.email || state.session?.user?.email || 'creator@virali.ai';

  $('#user-email').textContent = email;
  $('#user-avatar').textContent = (email[0] || 'U').toUpperCase();

  const chip = $('#plan-chip');
  chip.classList.toggle('is-active', active);
  chip.classList.toggle('is-expired', !active);
  $('#plan-chip-text').textContent = active ? 'Pro · Active' : 'Pro · Expired';
  $('#user-plan-label').textContent = active
    ? `Pro till ${formatDate(p.plan_expires_at)}`
    : 'Plan expired';

  const pill = $('#topbar-plan-pill');
  pill.textContent = active ? '💎 Pro Active' : 'Free / Expired';
  pill.classList.toggle('pill--is-active', active);
  pill.classList.toggle('pill--is-expired', !active);

  renderBilling();
}

/**
 * LOCK LOGIC — mirrors the backend rule `plan_expires_at < NOW()`.
 * Shows the full-screen payment lock whenever the subscription is dead.
 */
function enforceLock() {
  if (state.suppressLock) return; // let the success message breathe first
  const expired = !isPlanActive(state.profile);
  const overlay = $('#lock-overlay');

  if (expired && !state.lockDismissed) {
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
  } else {
    overlay.hidden = true;
    document.body.style.overflow = '';
  }
}

/** Periodic re-check (every TICK_MS) so long-open sessions re-lock correctly. */
function startExpiryTicker() {
  setInterval(async () => {
    if (!state.session) return;
    await loadProfile();
    if (state.screen === 'billing') renderBilling();
  }, CONFIG.TICK_MS);
}

/* ================================ UPI QR ================================ */
function upiHref() {
  return UPI_WEB_LINK;
}

function renderQR(canvasSel, imgSel) {
  const canvas = $(canvasSel);
  const img = imgSel ? $(imgSel) : null;
  if (!canvas) return;

  const draw = () => {
    if (window.QRCode?.toCanvas) {
      window.QRCode.toCanvas(canvas, UPI_DEEPLINK, {
        width: Number(canvas.width) || 208,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#0F172A', light: '#FFFFFF' },
      }, (err) => {
        if (err) {
          console.warn('[QR]', err);
          useFallback();
        }
      });
      return true;
    }
    return false;
  };

  const useFallback = () => {
    if (!img) return;
    canvas.hidden = true;
    img.hidden = false;
    img.src =
      'https://api.qrserver.com/v1/create-qr-code/?size=208x208&margin=0&data=' +
      encodeURIComponent(UPI_DEEPLINK);
  };

  if (draw()) return;

  // qrcode.js is deferred — wait briefly for it to land.
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (draw() || tries > 40) {
      clearInterval(timer);
      if (tries > 40) useFallback();
    }
  }, 120);
}

function paintUpiLinks() {
  const a = $('#upi-link');
  const l = $('#lock-upi-link');
  if (a) a.href = upiHref();
  if (l) l.href = upiHref();
  $('#upi-id').textContent = CONFIG.UPI.PA;
}

/* ============================ BILLING PANEL ============================= */
function renderBilling() {
  const p = state.profile;
  const active = isPlanActive(p);

  const statusEl = $('#billing-plan-status');
  const expiryEl = $('#billing-plan-expiry');

  statusEl.textContent = active ? '🟢 ACTIVE' : '🔴 EXPIRED / INACTIVE';
  statusEl.className = active ? 'is-active' : 'is-expired';
  expiryEl.textContent = p?.plan_expires_at ? formatDate(p.plan_expires_at, true) : '—';
}

async function loadPayments() {
  if (!state.session) return;
  const { data, error } = await supabase
    .from('upi_payments')
    .select('utr_number, amount, status, created_at')
    .order('created_at', { ascending: false })
    .limit(6);

  const box = $('#payment-list');
  if (error || !data?.length) {
    box.innerHTML = '<p class="muted">No transactions yet.</p>';
    return;
  }

  box.innerHTML = data
    .map(
      (r) => `
      <div class="payment-row">
        <span><code>${escapeHTML(r.utr_number)}</code></span>
        <span>₹${Number(r.amount).toFixed(2)}</span>
        <span class="${r.status === 'verified' ? 'status-ok' : 'status-pending'}">
          ${r.status === 'verified' ? '✓ VERIFIED' : '⧗ PENDING'}
        </span>
        <span class="muted">${formatDate(r.created_at)}</span>
      </div>`
    )
    .join('');
}

/* ========================== UTR VERIFICATION ============================ */
const UTR_REGEX = /^\d{12}$/;

async function verifyUTR({ utr, btn, errorEl, successEl, onSuccess, deferUnlock = false }) {
  setFieldMessage({ errorEl, successEl });

  const clean = String(utr || '').replace(/\D/g, '');

  if (!UTR_REGEX.test(clean)) {
    setFieldMessage({
      errorEl,
      error: '⚠️ UTR / Reference No. must be exactly 12 digits (numbers only).',
    });
    return false;
  }

  if (!state.session) {
    setFieldMessage({ errorEl, error: 'Session expired. Please sign in again.' });
    return false;
  }

  setLoading(btn, true, 'Verifying with bank ref…');
  showLoader('🔒 Verifying UTR & activating Pro…');

  try {
    const token = state.session.access_token;
    const res = await callFunction(
      'verify-utr',
      { utr_number: clean, amount: CONFIG.PLAN_PRICE, plan_requested: 'pro_monthly' },
      token
    );

    if (!res.ok) {
      const message =
        res.data?.error ||
        res.data?.message ||
        'Verification failed. Please try again.';
      setFieldMessage({ errorEl, error: message });
      toast(message, 'error');

      // Server flagged the account — refresh profile to re-lock instantly.
      if (res.status === 403 || res.status === 429) await loadProfile();
      return false;
    }

    const successMsg =
      res.data?.message ||
      '✅ UTR verified! Your ViralAI Pro plan is now active for 30 days.';

    setFieldMessage({ successEl, success: successMsg });
    toast('💎 Pro plan activated for 30 days!', 'success');

    state.lockDismissed = false;

    // Keep the confirmation visible before releasing the lock overlay.
    if (deferUnlock) state.suppressLock = true;

    await loadProfile();
    renderBilling();
    await loadPayments();
    if (typeof onSuccess === 'function') onSuccess(res.data);

    if (deferUnlock) {
      setTimeout(() => {
        state.suppressLock = false;
        enforceLock();
      }, 2400);
    }
    return true;
  } catch (err) {
    setFieldMessage({ errorEl, error: `Network error: ${err.message}` });
    return false;
  } finally {
    setLoading(btn, false);
    hideLoader();
  }
}

function bindUtrForms() {
  // Billing panel
  $('#utr-form').addEventListener('submit', (e) => {
    e.preventDefault();
    verifyUTR({
      utr: $('#utr-input').value,
      btn: $('#btn-verify-utr'),
      errorEl: $('#utr-status'),
      successEl: $('#utr-success'),
      onSuccess: () => { $('#utr-form').reset(); },
    });
  });

  // Lock overlay
  $('#lock-utr-form').addEventListener('submit', (e) => {
    e.preventDefault();
    verifyUTR({
      utr: $('#lock-utr-input').value,
      btn: $('#btn-lock-verify'),
      errorEl: $('#lock-utr-status'),
      successEl: $('#lock-utr-success'),
      deferUnlock: true,
      onSuccess: () => $('#lock-utr-form').reset(),
    });
  });

  // Digits-only convenience on both inputs
  ['utr-input', 'lock-utr-input'].forEach((id) => {
    $(`#${id}`).addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 12);
    });
  });

  $('#btn-lock-dismiss').addEventListener('click', () => {
    state.lockDismissed = true;
    enforceLock();
    toast('Read-only mode. AI generation stays locked until you renew.');
  });
}

/* ========================= AI GENERATION (3 MODULES) ==================== */

/**
 * Shared transport to netlify/functions/generate-ai
 * @returns {Promise<object>} parsed payload
 */
async function generate(type, payload, btn, loadingText) {
  const active = isPlanActive(state.profile);
  if (!active) {
    state.lockDismissed = false;
    enforceLock();
    toast('Subscription expired — renew for ₹99 to continue.', 'error');
    throw new Error('Plan expired');
  }

  setLoading(btn, true, 'Generating…');
  showLoader(loadingText);

  try {
    const res = await callFunction('generate-ai', { type, ...payload }, state.session.access_token);

    if (!res.ok) {
      const msg = res.data?.error || 'AI generation failed. Please retry.';
      toast(msg, 'error');
      if (res.status === 402 || res.status === 403) await loadProfile();
      throw new Error(msg);
    }
    return res.data;
  } finally {
    setLoading(btn, false);
    hideLoader();
  }
}

/** Normalise whatever the model returned into a stable array of hooks. */
function normaliseHooks(raw) {
  const list = Array.isArray(raw) ? raw : raw?.hooks || raw?.results || [];
  return list
    .map((h, i) =>
      typeof h === 'string'
        ? { hook: h, angle: `Hook ${i + 1}` }
        : {
            hook: h.hook || h.text || h.title || String(h),
            angle: h.angle || h.why || h.type || `Hook ${i + 1}`,
          }
    )
    .filter((h) => h.hook)
    .slice(0, 8);
}

async function handleGenerateHooks() {
  const topic = $('#hook-topic').value.trim();
  const btn = $('#btn-generate-hooks');

  if (topic.length < 3) {
    toast('Enter a topic or niche first (min 3 characters).', 'error');
    $('#hook-topic').focus();
    return;
  }

  try {
    const data = await generate(
      'hook',
      { topic, tone: $('#hook-tone').value, platform: $('#hook-platform').value },
      btn,
      '🪝 Writing 5 scroll-stopping hooks…'
    );

    state.lastHooks = normaliseHooks(data.result ?? data);
    renderHooks(state.lastHooks);
    toast(`${state.lastHooks.length} viral hooks generated ⚡`, 'success');
  } catch { /* toast already shown */ }
}

function renderHooks(hooks) {
  const box = $('#hooks-output');

  if (!hooks.length) {
    box.innerHTML = `<div class="empty-state"><span class="empty-state__icon">🪝</span><p>No hooks returned. Try again.</p></div>`;
    return;
  }

  box.innerHTML = hooks
    .map(
      (h, i) => `
      <article class="result-item">
        <span class="result-item__index">${i + 1}</span>
        <div class="result-item__text">${escapeHTML(h.hook)}</div>
        <div class="result-item__meta">Angle: ${escapeHTML(h.angle)}</div>
        <button class="result-item__copy" data-copy="${escapeHTML(h.hook)}" title="Copy hook">📋</button>
      </article>`
    )
    .join('');
}

async function handleGenerateScript() {
  const subject = $('#script-subject').value.trim();
  const btn = $('#btn-generate-script');

  if (subject.length < 8) {
    toast('Describe your video subject in a bit more detail.', 'error');
    $('#script-subject').focus();
    return;
  }

  try {
    const data = await generate(
      'script',
      {
        subject,
        length: $('#script-length').value,
        tone: $('#script-tone').value,
      },
      btn,
      '🎬 Structuring Hook → Body → CTA…'
    );

    state.lastScript = data.result ?? data;
    renderScript(state.lastScript);
    toast('Reel script ready 🎬', 'success');
  } catch { /* handled */ }
}

function renderScript(script) {
  const box = $('#script-output');
  const s = script || {};

  const blocks = [
    { label: '🪝 Part 1 — Hook (0-3s)', text: s.hook || s.part1 || '', cls: '' },
    { label: '📖 Part 2 — Body', text: s.body || s.part2 || '', cls: '' },
    { label: '📣 Part 3 — CTA', text: s.cta || s.part3 || '', cls: 'script-block--cta' },
  ].filter((b) => b.text);

  if (!blocks.length) {
    box.innerHTML = '<div class="empty-state"><span class="empty-state__icon">🎬</span><p>Nothing returned. Please retry.</p></div>';
    return;
  }

  const meta = [
    s.title ? `<span class="tag">${escapeHTML(s.title)}</span>` : '',
    s.estimated_duration || s.duration ? `<span class="tag">${escapeHTML(s.estimated_duration || s.duration)}</span>` : '',
    s.word_count ? `<span class="tag">${escapeHTML(s.word_count)} words</span>` : '',
  ].join('');

  box.innerHTML =
    (meta ? `<div class="chip-wrap" style="margin-bottom:4px">${meta}</div>` : '') +
    blocks
      .map(
        (b) => `
      <article class="result-item script-block ${b.cls}">
        <span class="script-block__label">${b.label}</span>
        <div class="script-block__body">${escapeHTML(b.text)}</div>
        <button class="result-item__copy" data-copy="${escapeHTML(b.text)}" title="Copy section">📋</button>
      </article>`
      )
      .join('');
}

async function handleGenerateCaption() {
  const topic = $('#caption-topic').value.trim();
  const btn = $('#btn-generate-caption');

  if (topic.length < 6) {
    toast('Add a video topic so the caption stays relevant.', 'error');
    $('#caption-topic').focus();
    return;
  }

  try {
    const data = await generate(
      'caption',
      {
        topic,
        platform: $('#caption-platform').value,
        keyword: $('#caption-keyword').value.trim(),
      },
      btn,
      '✨ Optimising caption + hashtags…'
    );

    state.lastCaption = data.result ?? data;
    renderCaption(state.lastCaption);
    toast('SEO caption + hashtags ready ✨', 'success');
  } catch { /* handled */ }
}

function renderCaption(c) {
  const box = $('#caption-output');
  const data = c || {};
  const caption = data.caption || data.text || '';
  const tags = (data.hashtags || data.tags || []).map(String);
  const keywords = (data.seo_keywords || data.keywords || []).map(String);

  if (!caption && !tags.length) {
    box.innerHTML = '<div class="empty-state"><span class="empty-state__icon">#️⃣</span><p>Nothing returned. Please retry.</p></div>';
    return;
  }

  box.innerHTML =
    `
    <article class="result-item">
      <span class="script-block__label" style="color:var(--primary)">✍️ Caption</span>
      <div class="script-block__body">${escapeHTML(caption)}</div>
      <button class="result-item__copy" data-copy="${escapeHTML(caption)}" title="Copy caption">📋</button>
    </article>` +
    (tags.length
      ? `<article class="result-item">
           <span class="script-block__label" style="color:var(--primary)"># Viral Hashtags</span>
           <div class="chip-wrap">${tags
             .map((t) => `<span class="chip" data-copy="${escapeHTML(t.startsWith('#') ? t : '#' + t)}">${escapeHTML(t.startsWith('#') ? t : '#' + t)}</span>`)
             .join('')}</div>
         </article>`
      : '') +
    (keywords.length
      ? `<article class="result-item">
           <span class="script-block__label" style="color:var(--primary)">🔎 SEO Keywords</span>
           <div class="chip-wrap">${keywords.map((k) => `<span class="chip">${escapeHTML(k)}</span>`).join('')}</div>
         </article>`
      : '');
}

/* ============================== PLANNER ================================= */
const PLANNER_STATUSES = ['idea', 'scripted', 'filmed', 'posted'];

async function loadPlanner() {
  if (!state.session) return;

  const { data, error } = await supabase
    .from('content_planner')
    .select('id, title, platform, status, scheduled_date, script_content')
    .order('scheduled_date', { ascending: true, nullsFirst: false });

  if (error) {
    toast(`Planner load failed: ${error.message}`, 'error');
    return;
  }

  state.planner = data || [];
  renderPlanner();
}

function renderPlanner() {
  PLANNER_STATUSES.forEach((status) => {
    const list = document.querySelector(`[data-list="${status}"]`);
    const items = state.planner.filter((p) => p.status === status);
    const counter = document.querySelector(`[data-count="${status}"]`);
    if (counter) counter.textContent = items.length;
    if (!list) return;

    list.innerHTML = items.length
      ? items
          .map(
            (p) => `
        <article class="kanban-card" draggable="true" data-id="${p.id}" tabindex="0">
          <div class="kanban-card__title">${escapeHTML(p.title)}</div>
          <div class="kanban-card__meta">
            <span class="tag">${escapeHTML(p.platform || 'Instagram')}</span>
            ${p.scheduled_date ? `<span class="tag tag--date">📅 ${escapeHTML(p.scheduled_date)}</span>` : ''}
          </div>
        </article>`
          )
          .join('')
      : `<div class="kanban__empty">Drop a card here</div>`;
  });

  bindDragAndDrop();
}

function bindDragAndDrop() {
  let draggingId = null;

  $$('.kanban-card').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      draggingId = card.dataset.id;
      card.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', draggingId); } catch { /* noop */ }
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('is-dragging');
      draggingId = null;
    });

    card.addEventListener('click', () => openPlannerModal(card.dataset.id));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPlannerModal(card.dataset.id);
      }
    });
  });

  $$('.kanban__col').forEach((col) => {
    const status = col.dataset.status;

    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('is-dragover');
    });

    col.addEventListener('dragleave', (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('is-dragover');
    });

    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('is-dragover');
      const id = e.dataTransfer.getData('text/plain') || draggingId;
      if (!id) return;

      const item = state.planner.find((p) => p.id === id);
      if (!item || item.status === status) return;

      const prev = item.status;
      item.status = status;                       // optimistic paint
      renderPlanner();

      const { error } = await supabase
        .from('content_planner')
        .update({ status })
        .eq('id', id);

      if (error) {
        item.status = prev;
        renderPlanner();
        toast(`Update failed: ${error.message}`, 'error');
        return;
      }
      toast(`Moved to “${status.toUpperCase()}” 🔄`, 'success');
    });
  });
}

function openPlannerModal(id = null) {
  const modal = $('#planner-modal');
  const item = id ? state.planner.find((p) => p.id === id) : null;

  $('#planner-modal-title').textContent = item ? 'Edit content idea' : 'New content idea';
  $('#planner-id').value = item?.id || '';
  $('#planner-title').value = item?.title || '';
  $('#planner-platform').value = item?.platform || 'Instagram';
  $('#planner-status').value = item?.status || 'idea';
  $('#planner-date').value = item?.scheduled_date || '';
  $('#planner-script').value = item?.script_content || '';
  $('#btn-planner-delete').hidden = !item;

  setFieldMessage({ errorEl: $('#planner-error') });
  modal.hidden = false;
  setTimeout(() => $('#planner-title').focus(), 60);
}

function closePlannerModal() {
  $('#planner-modal').hidden = true;
}

async function savePlannerItem(e) {
  e.preventDefault();
  const id = $('#planner-id').value;
  const title = $('#planner-title').value.trim();
  const btn = $('#btn-planner-save');

  if (title.length < 3) {
    setFieldMessage({ errorEl: $('#planner-error'), error: 'Title must be at least 3 characters.' });
    return;
  }

  const payload = {
    title,
    platform: $('#planner-platform').value,
    status: $('#planner-status').value,
    scheduled_date: $('#planner-date').value || null,
    script_content: $('#planner-script').value.trim(),
    user_id: state.session.user.id,
  };

  setLoading(btn, true, 'Saving…');

  try {
    const { data, error } = id
      ? await supabase.from('content_planner').update(payload).eq('id', id).select().single()
      : await supabase.from('content_planner').insert(payload).select().single();

    if (error) throw error;

    const idx = state.planner.findIndex((p) => p.id === data.id);
    if (idx >= 0) state.planner[idx] = data;
    else state.planner.push(data);

    renderPlanner();
    closePlannerModal();
    toast(id ? 'Card updated ✅' : 'Card added to pipeline 🗓️', 'success');
  } catch (err) {
    setFieldMessage({ errorEl: $('#planner-error'), error: err.message });
  } finally {
    setLoading(btn, false);
  }
}

async function deletePlannerItem() {
  const id = $('#planner-id').value;
  if (!id) return;
  if (!confirm('Delete this card permanently?')) return;

  const { error } = await supabase.from('content_planner').delete().eq('id', id);
  if (error) {
    setFieldMessage({ errorEl: $('#planner-error'), error: error.message });
    return;
  }

  state.planner = state.planner.filter((p) => p.id !== id);
  renderPlanner();
  closePlannerModal();
  toast('Card deleted 🗑️');
}

function bindPlanner() {
  $('#btn-add-card').addEventListener('click', () => openPlannerModal());
  $('#planner-form').addEventListener('submit', savePlannerItem);
  $('#btn-planner-delete').addEventListener('click', deletePlannerItem);
  $$('[data-close-modal]').forEach((el) => el.addEventListener('click', closePlannerModal));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#planner-modal').hidden) closePlannerModal();
  });
}

/* ============================== COPY HOOKS ============================== */
function bindCopyDelegation() {
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-copy]');
    if (!el) return;
    const ok = await copyText(el.dataset.copy);
    toast(ok ? 'Copied to clipboard 📋' : 'Copy failed — select manually.', ok ? 'success' : 'error');
  });

  $('#btn-copy-hooks').addEventListener('click', async () => {
    const text = state.lastHooks.map((h, i) => `${i + 1}. ${h.hook}`).join('\n');
    if (!text) return toast('Nothing to copy yet.');
    toast((await copyText(text)) ? 'All hooks copied 📋' : 'Copy failed.', 'success');
  });

  $('#btn-copy-script').addEventListener('click', async () => {
    const s = state.lastScript;
    if (!s) return toast('Nothing to copy yet.');
    const text = [
      '🪝 HOOK', s.hook || s.part1 || '',
      '\n📖 BODY', s.body || s.part2 || '',
      '\n📣 CTA', s.cta || s.part3 || '',
    ].join('\n');
    toast((await copyText(text)) ? 'Script copied 📋' : 'Copy failed.', 'success');
  });

  $('#btn-copy-caption').addEventListener('click', async () => {
    const c = state.lastCaption;
    if (!c) return toast('Nothing to copy yet.');
    const tags = (c.hashtags || c.tags || []).map((t) => (t.startsWith('#') ? t : '#' + t)).join(' ');
    const text = `${c.caption || c.text || ''}\n\n${tags}`.trim();
    toast((await copyText(text)) ? 'Caption + hashtags copied 📋' : 'Copy failed.', 'success');
  });

  $('#btn-copy-upi').addEventListener('click', async () => {
    const text = `${CONFIG.UPI.PA} · ₹99.00\n${UPI_DEEPLINK}`;
    toast((await copyText(text)) ? 'UPI ID & deeplink copied 📋' : 'Copy failed.', 'success');
  });
}

/* ================================ BOOT ================================== */
function showApp() {
  $('#auth-screen').hidden = true;
  $('#app-shell').hidden = false;
}

function showAuth() {
  $('#app-shell').hidden = true;
  $('#auth-screen').hidden = false;
}

async function bootWithSession(session) {
  state.session = session;
  showApp();
  await loadProfile();
  navigate('hooks');
  loadPlanner();
}

function bindAuthUI() {
  $('#auth-form').addEventListener('submit', handleAuthSubmit);
  $('#auth-toggle').addEventListener('click', () => {
    state.authMode = state.authMode === 'signin' ? 'signup' : 'signin';
    setFieldMessage({ errorEl: $('#auth-error') });
    paintAuthMode();
  });
  $('#btn-logout').addEventListener('click', signOut);
}

function bindGeneration() {
  $('#btn-generate-hooks').addEventListener('click', handleGenerateHooks);
  $('#btn-generate-script').addEventListener('click', handleGenerateScript);
  $('#btn-generate-caption').addEventListener('click', handleGenerateCaption);

  // Ctrl/Cmd + Enter shortcuts
  $('#hook-topic').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleGenerateHooks();
  });
  $('#caption-topic').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleGenerateCaption();
  });
}

async function init() {
  paintAuthMode();
  bindAuthUI();
  bindNavigation();
  bindGeneration();
  bindPlanner();
  bindUtrForms();
  bindCopyDelegation();

  paintUpiLinks();
  renderQR('#upi-qr', '#upi-qr-fallback');
  renderQR('#lock-qr', '#lock-qr-fallback');
  renderBilling();

  // Auth state machine
  const { data } = await supabase.auth.getSession();
  if (data?.session) {
    await bootWithSession(data.session);
  } else {
    showAuth();
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) {
      if (!state.session) bootWithSession(session);
      else { state.session = session; loadProfile(); }
    } else if (state.session) {
      signOut();
    }
  });

  startExpiryTicker();

  console.log('%c ViralAI SaaS %c loaded ',
    'background:#6366F1;color:#fff;padding:2px 8px;border-radius:6px 0 0 6px;font-weight:700',
    'background:#10B981;color:#04231A;padding:2px 8px;border-radius:0 6px 6px 0;font-weight:700');
}

document.addEventListener('DOMContentLoaded', init);

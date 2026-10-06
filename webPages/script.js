(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  /* ---------- nav shadow ---------- */
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- scroll reveal ---------- */
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
        }
      }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' })
    : null;
  $$('.reveal').forEach((el) => (io ? io.observe(el) : el.classList.add('in')));

  /* ---------- language toggle (zh-Hant <-> en) ---------- */
  const i18n = $$('[data-en]');
  const alts = $$('[data-en-alt]');
  i18n.forEach((el) => { el.dataset.zh = el.innerHTML; });
  alts.forEach((el) => { el.dataset.zhAlt = el.alt; });
  const titles = {
    'zh-Hant': ['VelaHarness — 在本地倉庫工作的桌面 AI 編程助手', '在本地程式碼倉庫中工作的桌面 AI 編程助手：緊湊模式、Codex 同款 SubAgents、DeepSeek Harness 同款軌跡介面。'],
    en: ['VelaHarness — a desktop AI coding assistant for your local repo', 'A desktop AI coding assistant that works in your local repository: compact mode, Codex-style SubAgents, and a DeepSeek Harness-style trace view.'],
  };
  function setLang(lang) {
    document.documentElement.lang = lang;
    const en = lang === 'en';
    i18n.forEach((el) => { el.innerHTML = en ? el.dataset.en : el.dataset.zh; });
    alts.forEach((el) => { el.alt = en ? el.dataset.enAlt : el.dataset.zhAlt; });
    document.title = titles[lang][0];
    $('meta[name="description"]').content = titles[lang][1];
    store.set('vela-lang', lang);
    bindCopy();
  }
  $('#lang').addEventListener('click', () => {
    setLang(document.documentElement.lang === 'en' ? 'zh-Hant' : 'en');
  });
  const saved = store.get('vela-lang');
  if (saved === 'en' || (!saved && /^en/i.test(navigator.language) && !/^zh/i.test(navigator.language))) setLang('en');

  /* ---------- count up ---------- */
  const counters = $$('[data-count]');
  const countIO = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          countIO.unobserve(e.target);
          const el = e.target, to = +el.dataset.count;
          if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = to; continue; }
          const t0 = performance.now(), dur = 1100;
          const tick = (t) => {
            const p = Math.min(1, (t - t0) / dur);
            el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3)));
            if (p < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      }, { threshold: 0.6 })
    : null;
  counters.forEach((c) => countIO && countIO.observe(c));

  /* ---------- hero tilt ---------- */
  const stage = $('#stage'), shot = $('.shot', stage);
  if (stage && matchMedia('(hover: hover) and (pointer: fine)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    stage.addEventListener('pointermove', (e) => {
      const r = stage.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      shot.style.transform = `rotateY(${x * 5}deg) rotateX(${-y * 4}deg)`;
    });
    stage.addEventListener('pointerleave', () => { shot.style.transform = ''; });
  }

  /* ---------- mode tabs ---------- */
  const tabs = $$('.mode-tab'), panels = $$('.mode-panel');
  function pick(name) {
    tabs.forEach((t) => { const on = t.dataset.mode === name; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); });
    panels.forEach((p) => p.classList.toggle('on', p.dataset.panel === name));
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => pick(t.dataset.mode));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      n.focus(); pick(n.dataset.mode);
    });
  });

  /* ---------- copy command ---------- */
  function bindCopy() {
    const btn = $('#copy');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const text = $('#cmd').innerText.split('\n').filter((l) => l.trim() && !l.startsWith('#')).join('\n');
      try { await navigator.clipboard.writeText(text); } catch { return; }
      const en = document.documentElement.lang === 'en';
      btn.textContent = en ? 'Copied ✓' : '已複製 ✓';
      setTimeout(() => { btn.innerHTML = en ? btn.dataset.en : btn.dataset.zh; }, 1600);
    });
  }
  bindCopy();
})();

'use strict';
// Theme: "system" (follows the phone/PC setting), "light" or "dark". Loaded in <head> so the page never flashes.
(function () {
  const KEY = 'gct-theme';
  const get = () => { try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; } };
  const apply = (mode) => {
    const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.themeMode = mode;
  };
  apply(get());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (get() === 'system') apply('system'); });
  const LABELS = { system: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' };
  window.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('themeBtn');
    if (!btn) return;
    const label = () => { const m = get(); btn.setAttribute('aria-label', LABELS[m]); btn.title = LABELS[m]; btn.dataset.mode = m; };
    label();
    btn.addEventListener('click', () => {
      const next = { system: 'light', light: 'dark', dark: 'system' }[get()];
      try { localStorage.setItem(KEY, next); } catch { /* private mode: still switch for this page */ }
      apply(next);
      label();
    });
  });
}());

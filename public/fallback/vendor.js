/* global document */

(() => {
  // Runtime fallback when webpack bundles are unavailable in the deployment package.
  // Keep the UI usable by loading Bootstrap CSS from CDN.
  const href = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css';
  const existing = [...document.querySelectorAll('link[rel="stylesheet"]')].some((link) => link.href === href);
  if (!existing) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.append(link);
  }
})();

// Injected by tbweb-sw.js into every in-world HTML page: tells the browser where it is (the
// in-world URL and title), and sends links added after load that leave this origin through the
// target origin's bootstrap (the worker already rewrote the ones in the HTML).
(() => {
  let world = document.currentScript?.dataset.world || '';
  let error = document.currentScript?.dataset.error === '1'; // the engine's own error page
  let suffix = location.host.slice(location.host.indexOf('.web.') + 1);
  let labelOf = (origin) => {
    let u = new URL(origin);
    let https = u.protocol === 'https:';
    let port = u.port && Number(u.port) !== (https ? 443 : 80) ? u.port : '';
    return (https ? 's' : 'h') + port + 'x' + u.hostname.toLowerCase().replace(/-/g, '--').replace(/\./g, '-');
  };
  let report = () => {
    try {
      window.top.postMessage({ t: 'tbweb-page', url: world, title: document.title, error }, '*');
    } catch {}
  };
  addEventListener('DOMContentLoaded', report);
  addEventListener('load', report);
  addEventListener(
    'click',
    (e) => {
      let a = e.target?.closest?.('a[href]');
      if (!a || e.defaultPrevented) return;
      let u = new URL(a.href, location.href);
      if (u.origin === location.origin || u.host.endsWith('.' + suffix) || !/^https?:$/.test(u.protocol)) return;
      e.preventDefault();
      location.href = `${location.protocol}//${labelOf(u.origin)}.${suffix}/other/web/boot.html?to=${encodeURIComponent(u.pathname + u.search + u.hash)}`;
    },
    true,
  );
})();

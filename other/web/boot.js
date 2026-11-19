// First visit to an in-world origin's subdomain: install its service worker (/tbweb-sw.js), make
// sure the desktop runs a broker for it, then open the page (?to=path) — now served by the worker.
(async () => {
  let to = new URLSearchParams(location.search).get('to') || '/';
  if (!to.startsWith('/') || to.startsWith('//')) to = '/';
  let id = Math.random().toString(36).slice(2);
  let brokerReady = new Promise((resolve) => {
    addEventListener('message', function on(ev) {
      if (ev.data?.t === 'tbweb-broker-ok' && ev.data.id === id) {
        removeEventListener('message', on);
        resolve(true);
      }
    });
    setTimeout(() => resolve(false), 10000);
  });
  try {
    window.top.postMessage({ t: 'tbweb-need-broker', origin: location.origin, id }, '*');
  } catch {}
  await navigator.serviceWorker.register('/tbweb-sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  await brokerReady;
  location.replace(to);
})();

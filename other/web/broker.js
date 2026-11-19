// One per in-world origin, hidden in the desktop (other/web/engine.js): relays this origin's
// service worker requests to the desktop's network engine over a MessagePort the desktop hands
// over, and the engine answers the worker directly on the port the worker sent along.
let port = null;
let queue = [];
let send = (msg, transfer) => (port ? port.postMessage(msg, transfer) : queue.push([msg, transfer]));
addEventListener('message', (ev) => {
  if (ev.source !== window.parent || ev.data?.t !== 'tbweb-broker-port' || !ev.ports[0]) return;
  port = ev.ports[0];
  for (let [m, t] of queue.splice(0)) port.postMessage(m, t);
});
navigator.serviceWorker.addEventListener('message', (ev) => {
  if (ev.data?.t !== 'tbweb-fetch' || !ev.ports[0]) return;
  let req = ev.data.req;
  send({ t: 'fetch', req }, [ev.ports[0], ...(req.body ? [req.body] : [])]);
});
navigator.serviceWorker.startMessages?.();
navigator.serviceWorker.register('/tbweb-sw.js', { scope: '/' }).catch(() => {});
window.parent.postMessage({ t: 'tbweb-broker-ready', origin: location.origin }, '*');

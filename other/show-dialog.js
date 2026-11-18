/**
 * showDialog(component, props): mount a component as a non-modal app layer.
 *
 * Project-side (not in the managed webfoundry/ runtime). Unlike showModal there
 * is no backdrop — the component root positions itself (window chrome). Returns
 * a Promise that resolves on close and also exposes `{ close, el }`.
 * Relies on the runtime globals renderComponent, d and arrayify.
 */
export function showDialog(x, props = {}) {
  let { promise: p, resolve: res } = Promise.withResolvers();
  let content = renderComponent(x, props);
  let holder = d.el('div', { class: 'contents', 'data-wf-dialog': String(x) }, content);
  let layer =
    document.querySelector('[data-app-layer]') ||
    document.querySelector('[data-desktop-root]') ||
    document.body;
  layer.append(holder);

  let closed = false;
  let obs;
  let finish = (returnValue, returnDetail) => {
    if (closed) return;
    closed = true;
    try {
      obs.disconnect();
    } catch {}
    try {
      holder.remove();
    } catch {}
    res([returnValue, ...(arrayify(returnDetail) || [])]);
  };

  obs = new MutationObserver(() => {
    if (!closed && !holder.isConnected) finish('', []);
  });
  try {
    obs.observe(layer, { childList: true });
  } catch {}

  return Object.assign(p, {
    el: holder,
    close(returnValue = '', ...returnDetail) {
      finish(returnValue, returnDetail);
    },
  });
}

window.showDialog ??= showDialog;

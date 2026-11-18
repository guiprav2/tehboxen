import { PLAYER, PLAYER_HOME } from '../other/session.js';
import * as places from '../other/places.js';
import * as vfs from '../other/vfs.js';

/**
 * Local Places map: current place centered, exits on a ring.
 * Move animates a traveler to the dest bubble, then shifts that bubble
 * to center while old/new neighborhoods cross-fade.
 */
export default class Places {
  state = {
    ready: false,
    error: '',
    me: PLAYER,
    here: null,
    /** Human-readable name for `here` (from place.yaml). */
    hereName: '',
    nodes: [],
    edges: [],
    selected: null,
    status: '',
    moving: false,
  };

  _canvas = null;
  _layout = {}; // id → {x,y,r}
  _pictures = {}; // id → HTMLImageElement | null
  _allNodes = [];
  _allEdges = [];
  _unsub = null;
  _ro = null;
  _refreshTimer = 0;
  _initPromise = null;
  _raf = 0;
  _idleRaf = 0;
  _stars = null; // cached starfield for current buffer size
  /** @type {null | object} */
  _anim = null;

  actions = {
    init: async () => {
      this.actions._ensureWatch();
      if (this.state.ready) {
        await this.actions.refresh();
        return;
      }
      if (this._initPromise) return this._initPromise;
      this._initPromise = (async () => {
        await vfs.ensureReady();
        // World graph lives in the VFS / imported packs — never invent places here.
        let ids = await places.listPlaceIds();
        if (!ids.length) {
          this.state.error =
            'No places in VFS. Import a world pack from Danger Zone.';
        }
        this.actions._ensureWatch();
        this.state.ready = true;
        await this.actions.refresh();
      })();
      try {
        await this._initPromise;
      } finally {
        this._initPromise = null;
      }
    },

    _ensureWatch: () => {
      if (this._unsub) return;
      this._unsub = vfs.onChange((ev) => {
        let p = String(ev?.path || '');
        if (
          p.startsWith('places/') ||
          p.endsWith('/location') ||
          p.endsWith('/presence.yaml')
        ) {
          if (this._anim || this.state.moving) return;
          clearTimeout(this._refreshTimer);
          this._refreshTimer = setTimeout(() => this.actions.refresh(), 120);
        }
      });
    },

    refresh: async () => {
      if (this._anim) return;
      try {
        if (!this.state.ready) {
          await vfs.ensureReady();
          this.state.ready = true;
        }
        let graph = await places.loadGraph({ viewer: this.state.me });
        this._allNodes = graph.nodes;
        this._allEdges = graph.edges;
        this.state.here = graph.here || (await places.whereIs(this.state.me));
        // Location symlink can vanish during heavy presence churn; re-seat so
        // the local map has a center instead of an empty/orphan view.
        if (!this.state.here && this._allNodes.length) {
          let fallback = this._allNodes[0].id;
          try {
            await places.moveTo(this.state.me, fallback, {
              force: true,
              log: false,
            });
            this.state.here = fallback;
          } catch (err) {
            console.warn('places.reseat', err);
          }
        }
        this.state.hereName = this._placeName(this.state.here);
        this._applyLocalView();
        this.state.error = '';
        this.actions.ensureCanvas();
        this._layoutLocal(true);
        this._loadPictures();
        d.update();
        this.actions._scheduleDraw(false);
      } catch (err) {
        this.state.error = err?.message || String(err);
        d.update();
      }
    },

    ensureCanvas: () => {
      let canvas =
        this._canvas && this._canvas.isConnected
          ? this._canvas
          : document.querySelector(
              '#Places canvas[data-places-canvas], dialog canvas[data-places-canvas], canvas[data-places-canvas]',
            );
      if (!canvas) return null;
      this._canvas = canvas;
      this._bindCanvas();
      return canvas;
    },

    onAttach: async (el, winId) => {
      try {
        if (winId) post('desktop.registerWindow', winId);
      } catch {}
      let root =
        el?.id === 'Places'
          ? el
          : el?.closest?.('#Places') || el?.querySelector?.('#Places') || el;
      let canvas =
        root?.querySelector?.('canvas[data-places-canvas], canvas') ||
        (el?.tagName === 'CANVAS' ? el : null);
      if (canvas) {
        if (this._canvas && this._canvas !== canvas) {
          try {
            this._ro?.disconnect?.();
          } catch {}
          this._ro = null;
          try {
            delete this._canvas.__placesRoBound;
          } catch {}
        }
        this._canvas = canvas;
        this._bindCanvas();
      }
      await this.actions.init();
      this.actions._scheduleDraw(true);
      this._startIdlePulse();
    },

    _scheduleDraw: (relayout = false) => {
      let paint = () => {
        this.actions.ensureCanvas();
        if (relayout && !this._anim) this._layoutLocal(true);
        this._draw();
      };
      requestAnimationFrame(() => {
        paint();
        requestAnimationFrame(paint);
      });
    },

    onDetach: () => {
      this._stopIdlePulse();
      if (this._ro) {
        try {
          this._ro.disconnect();
        } catch {}
        this._ro = null;
      }
      if (this._canvas) {
        try {
          delete this._canvas.__placesRoBound;
        } catch {}
      }
      this._canvas = null;
      // Keep anim running only while window exists; cancel if detached mid-move.
      if (this._anim) this._cancelAnim(false);
    },

    select: (id) => {
      if (this.state.moving) return;
      this.state.selected = id || null;
      this._draw();
      d.update();
    },

    go: async (id) => {
      let dest = id || this.state.selected;
      if (!dest || this.state.moving || this._anim) return;
      if (dest === this.state.here) {
        this.state.status = this._placeName(dest) + ' (already here)';
        d.update();
        return;
      }
      let visible = this.state.nodes.some((n) => n.id === dest);
      if (!visible) {
        this.state.error = 'No exit to ' + this._placeName(dest) + ' from here';
        d.update();
        return;
      }

      this.state.moving = true;
      this.state.status = 'Walking to ' + this._placeName(dest) + '…';
      this.state.error = '';
      d.update();

      let fromId = this.state.here;
      let fromLayout = this._cloneLayout();
      let oldNodes = this.state.nodes.slice();
      let oldEdges = this.state.edges.slice();
      // Warm dest cover so settle can cross-fade starlight → new place.
      this._loadPictures();

      try {
        await this._runTravelAnim(fromId, dest, fromLayout);

        let r = await places.moveTo(this.state.me, dest);
        this.state.here = r.to;
        this.state.hereName = this._placeName(r.to);
        this.state.selected = null;

        let graph = await places.loadGraph({ viewer: this.state.me });
        this._allNodes = graph.nodes;
        this._allEdges = graph.edges;
        this.state.hereName = this._placeName(r.to);
        let next = this._localViewFor(r.to);
        let toLayout = this._computeLayout(next.nodes, r.to);

        await this._runSettleAnim({
          fromId,
          toId: dest,
          fromLayout,
          toLayout,
          oldNodes,
          oldEdges,
          newNodes: next.nodes,
          newEdges: next.edges,
        });

        this.state.nodes = next.nodes;
        this.state.edges = next.edges;
        this._layout = toLayout;
        this._loadPictures();
        this.state.status =
          (r.from ? this._placeName(r.from) + ' → ' : '') +
          this._placeName(r.to) +
          (r.from === r.to ? ' (already here)' : '');
      } catch (err) {
        this.state.error = err?.message || String(err);
        this.state.status = '';
        try {
          await this.actions.refresh();
        } catch {}
      } finally {
        this._anim = null;
        this.state.moving = false;
        d.update();
        this._draw();
      }
    },

    pointerDown: (event) => {
      if (this.state.moving) return;
      this.actions.ensureCanvas();
      let canvas = this._canvas;
      if (!canvas) return;
      let pt = this._eventPoint(event);
      let hit = this._hitNode(pt.x, pt.y);
      if (hit) {
        this.state.selected = hit.id;
        this._draw();
        d.update();
      }
    },

    pointerMove: () => {},

    pointerUp: () => {},

    dblClick: (event) => {
      if (this.state.moving) return;
      this.actions.ensureCanvas();
      let pt = this._eventPoint(event);
      let hit = this._hitNode(pt.x, pt.y);
      if (hit && hit.id !== this.state.here) this.actions.go(hit.id);
    },
  };

  _placeName(id) {
    if (!id) return '';
    let n =
      this._allNodes.find((x) => x.id === id) ||
      this.state.nodes.find((x) => x.id === id);
    return (n && n.name) || id;
  }

  _applyLocalView() {
    let view = this._localViewFor(this.state.here);
    this.state.nodes = view.nodes;
    this.state.edges = view.edges;
    this.state.hereName = this._placeName(this.state.here);
  }

  _localViewFor(hereId) {
    let here = hereId || null;
    let byId = new Map(this._allNodes.map((n) => [n.id, n]));
    if (!here || !byId.has(here)) {
      return { nodes: this._allNodes.slice(), edges: this._allEdges.slice() };
    }
    let neighborIds = new Set();
    let edges = [];
    for (let e of this._allEdges) {
      if (e.from === here) {
        neighborIds.add(e.to);
        edges.push(e);
      } else if (e.to === here) {
        neighborIds.add(e.from);
        edges.push(e);
      }
    }
    let nodes = [byId.get(here)];
    for (let id of [...neighborIds].sort()) {
      let n = byId.get(id);
      if (n) nodes.push(n);
    }
    return { nodes, edges };
  }

  _cloneLayout() {
    let out = {};
    for (let id of Object.keys(this._layout)) {
      let L = this._layout[id];
      out[id] = { x: L.x, y: L.y, r: L.r };
    }
    return out;
  }

  _canvasSize() {
    let canvas = this._canvas;
    return {
      w: canvas?.width || 720,
      h: canvas?.height || 420,
    };
  }

  _computeLayout(nodes, hereId) {
    let { w, h } = this._canvasSize();
    let cx = w / 2;
    let cy = h / 2;
    let R = Math.min(w, h) * 0.34;
    let rCenter = Math.max(36, Math.min(w, h) * 0.11);
    let rExit = Math.max(28, Math.min(w, h) * 0.085);
    let layout = {};
    let neighbors = nodes.filter((n) => n.id !== hereId);
    neighbors.sort((a, b) => a.id.localeCompare(b.id));
    if (hereId) {
      layout[hereId] = { x: cx, y: cy, r: rCenter };
    }
    let n = neighbors.length || 1;
    neighbors.forEach((node, i) => {
      let a = (i / n) * Math.PI * 2 - Math.PI / 2;
      layout[node.id] = {
        x: cx + Math.cos(a) * R,
        y: cy + Math.sin(a) * R,
        r: rExit,
      };
    });
    return layout;
  }

  _layoutLocal(force = false) {
    if (!force && Object.keys(this._layout).length) return;
    this._layout = this._computeLayout(this.state.nodes, this.state.here);
  }

  _ease(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  _cancelAnim(draw = true) {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    this._anim = null;
    if (draw) this._draw();
  }

  _runTravelAnim(fromId, toId, fromLayout) {
    return new Promise((resolve) => {
      let a = fromLayout[fromId];
      let b = fromLayout[toId];
      if (!a || !b) {
        resolve();
        return;
      }
      let dur = 520;
      this._anim = {
        phase: 'travel',
        t0: performance.now(),
        dur,
        fromId,
        toId,
        fromLayout,
        traveler: { x: a.x, y: a.y },
      };
      let tick = (now) => {
        let t = Math.min(1, (now - this._anim.t0) / dur);
        let e = this._ease(t);
        this._anim.t = e;
        this._anim.traveler = {
          x: a.x + (b.x - a.x) * e,
          y: a.y + (b.y - a.y) * e,
        };
        this._draw();
        if (t < 1) {
          this._raf = requestAnimationFrame(tick);
        } else {
          this._raf = 0;
          resolve();
        }
      };
      this._raf = requestAnimationFrame(tick);
    });
  }

  _runSettleAnim({
    fromId,
    toId,
    fromLayout,
    toLayout,
    oldNodes,
    oldEdges,
    newNodes,
    newEdges,
  }) {
    return new Promise((resolve) => {
      let dur = 640;
      this._anim = {
        phase: 'settle',
        t0: performance.now(),
        dur,
        fromId,
        toId,
        fromLayout,
        toLayout,
        oldNodes,
        oldEdges,
        newNodes,
        newEdges,
      };
      let tick = (now) => {
        let t = Math.min(1, (now - this._anim.t0) / dur);
        this._anim.t = this._ease(t);
        this._draw();
        if (t < 1) {
          this._raf = requestAnimationFrame(tick);
        } else {
          this._raf = 0;
          resolve();
        }
      };
      this._raf = requestAnimationFrame(tick);
    });
  }

  _eventPoint(event) {
    let canvas = this._canvas;
    let rect = canvas.getBoundingClientRect();
    let sx = canvas.width / Math.max(1, rect.width);
    let sy = canvas.height / Math.max(1, rect.height);
    return {
      x: (event.clientX - rect.left) * sx,
      y: (event.clientY - rect.top) * sy,
    };
  }

  _hitNode(x, y) {
    let layout = this._anim?.phase === 'settle' ? null : this._layout;
    if (this._anim?.phase === 'travel') layout = this._anim.fromLayout;
    for (let n of this.state.nodes) {
      let L = (layout || this._layout)[n.id];
      if (!L) continue;
      let dx = x - L.x;
      let dy = y - L.y;
      if (dx * dx + dy * dy <= L.r * L.r) return { ...n, ...L };
    }
    return null;
  }

  _loadPictures() {
    let pool = this._allNodes.length ? this._allNodes : this.state.nodes;
    for (let n of pool) {
      if (!n.picture) {
        this._pictures[n.id] = null;
        continue;
      }
      if (this._pictures[n.id]?.__src === n.picture) continue;
      let img = new Image();
      img.__src = n.picture;
      img.onload = () => this._draw();
      this._pictures[n.id] = img;
      let src = String(n.picture || '');
      // Pictures live in the VFS (world pack / seeded paths). Never host media/.
      vfs
        .withLock(src, (lease) => vfs.readBlob(src, { lease }), { mode: 'r', actor: 'ui:places' })
        .then((blob) => {
          if (!blob || this._pictures[n.id] !== img) return;
          img.src = URL.createObjectURL(blob);
        })
        .catch((err) => console.warn('places.picture', src, err));
    }
  }

  _bindCanvas() {
    let canvas = this._canvas;
    if (!canvas) return;
    let resize = () => {
      let parent = canvas.parentElement;
      // Prefer the laid-out map pane size; fall back only when not in DOM yet.
      let w = parent?.clientWidth || 0;
      let h = parent?.clientHeight || 0;
      if (w < 2 || h < 2) {
        w = canvas.clientWidth || 0;
        h = canvas.clientHeight || 0;
      }
      if (w < 2 || h < 2) return;

      let dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Buffer must match the CSS box aspect exactly — mins like 320×240
      // stretch the bitmap when the pane is wider/shorter (e.g. maximized).
      let bw = Math.max(1, Math.round(w * dpr));
      let bh = Math.max(1, Math.round(h * dpr));
      let sizeChanged = canvas.width !== bw || canvas.height !== bh;
      if (sizeChanged) {
        canvas.width = bw;
        canvas.height = bh;
        this._stars = null;
        if (!this._anim) this._layoutLocal(true);
      }
      // CSS box comes from absolute inset-0; do not set style width/height
      // (that fights inset and can reintroduce stretch).
      this._draw();
    };
    this._resizeCanvas = resize;
    resize();
    // Maximize/layout can settle a frame late — catch the follow-up size.
    requestAnimationFrame(() => {
      resize();
      requestAnimationFrame(resize);
    });
    if (!canvas.__placesRoBound) {
      canvas.__placesRoBound = true;
      try {
        if (this._ro) {
          try {
            this._ro.disconnect();
          } catch {}
        }
        this._ro = new ResizeObserver(() => {
          // rAF so we read after flex/maximize classes have applied.
          requestAnimationFrame(resize);
        });
        let root = canvas.closest('#Places') || canvas.parentElement || canvas;
        let pane = canvas.parentElement;
        this._ro.observe(root);
        if (pane && pane !== root) this._ro.observe(pane);
        this._ro.observe(canvas);
      } catch {}
    }
  }

  _startIdlePulse() {
    if (this._idleRaf) return;
    let tick = () => {
      this._idleRaf = requestAnimationFrame(tick);
      if (!this._canvas) return;
      // Catch maximize/geometry changes ResizeObserver might miss for a frame.
      if (this._resizeCanvas && !this._anim) {
        let parent = this._canvas.parentElement;
        let w = parent?.clientWidth || 0;
        let h = parent?.clientHeight || 0;
        let dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (
          w >= 2 &&
          h >= 2 &&
          (this._canvas.width !== Math.round(w * dpr) ||
            this._canvas.height !== Math.round(h * dpr))
        ) {
          this._resizeCanvas();
          return;
        }
      }
      // Soft pulse only when idle; anim path already redraws.
      if (!this._anim) this._draw();
    };
    this._idleRaf = requestAnimationFrame(tick);
  }

  _stopIdlePulse() {
    if (this._idleRaf) {
      cancelAnimationFrame(this._idleRaf);
      this._idleRaf = 0;
    }
  }

  _ensureStars(w, h) {
    if (this._stars && this._stars.w === w && this._stars.h === h) return this._stars;
    let count = Math.max(40, Math.floor((w * h) / 18000));
    let pts = [];
    let seed = (w * 73856093) ^ (h * 19349663);
    let rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    for (let i = 0; i < count; i++) {
      pts.push({
        x: rand() * w,
        y: rand() * h,
        r: 0.6 + rand() * 1.8,
        a: 0.15 + rand() * 0.55,
        tw: rand() * Math.PI * 2,
        sp: 0.4 + rand() * 1.2,
      });
    }
    this._stars = { w, h, pts };
    return this._stars;
  }

  /** Ready cover image for a place id, or null. */
  _coverImage(id) {
    if (!id) return null;
    let img = this._pictures[id];
    if (img && img.complete && img.naturalWidth) return img;
    return null;
  }

  /**
   * Backdrop mix: cover of the current (or transitioning) place at rest;
   * starlight only while traveling / settling, cross-faded both ways.
   * Returns { coverId, coverAlpha, starAlpha }.
   */
  _backdropMix() {
    let anim = this._anim;
    if (anim?.phase === 'travel') {
      let t = anim.t ?? 0;
      return { coverId: anim.fromId, coverAlpha: 1 - t, starAlpha: t };
    }
    if (anim?.phase === 'settle') {
      let t = anim.t ?? 0;
      return { coverId: anim.toId, coverAlpha: t, starAlpha: 1 - t };
    }
    let coverId = this.state.here;
    if (this._coverImage(coverId)) {
      return { coverId, coverAlpha: 1, starAlpha: 0 };
    }
    return { coverId, coverAlpha: 0, starAlpha: 1 };
  }

  _drawCoverBg(ctx, w, h, img, alpha) {
    if (!img || alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    let iw = img.naturalWidth;
    let ih = img.naturalHeight;
    let scale = Math.max(w / iw, h / ih);
    let dw = iw * scale;
    let dh = ih * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    // Keep map chrome readable over bright covers.
    ctx.fillStyle = 'rgba(12, 4, 22, 0.38)';
    ctx.fillRect(0, 0, w, h);
    let vig = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.28,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.72,
    );
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  _drawStarfield(ctx, w, h, alpha) {
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;

    let g = ctx.createRadialGradient(w * 0.5, h * 0.42, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
    g.addColorStop(0, '#3b1458');
    g.addColorStop(0.45, '#1c0a2e');
    g.addColorStop(1, '#0a0414');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Aurora washes
    let a1 = ctx.createRadialGradient(w * 0.2, h * 0.15, 0, w * 0.2, h * 0.15, w * 0.55);
    a1.addColorStop(0, 'rgba(255, 113, 206, 0.22)');
    a1.addColorStop(1, 'rgba(255, 113, 206, 0)');
    ctx.fillStyle = a1;
    ctx.fillRect(0, 0, w, h);

    let a2 = ctx.createRadialGradient(w * 0.85, h * 0.75, 0, w * 0.85, h * 0.75, w * 0.5);
    a2.addColorStop(0, 'rgba(1, 205, 254, 0.16)');
    a2.addColorStop(1, 'rgba(1, 205, 254, 0)');
    ctx.fillStyle = a2;
    ctx.fillRect(0, 0, w, h);

    let a3 = ctx.createRadialGradient(w * 0.55, h * 0.9, 0, w * 0.55, h * 0.9, h * 0.55);
    a3.addColorStop(0, 'rgba(168, 85, 247, 0.18)');
    a3.addColorStop(1, 'rgba(168, 85, 247, 0)');
    ctx.fillStyle = a3;
    ctx.fillRect(0, 0, w, h);

    let stars = this._ensureStars(w, h);
    let t = performance.now() / 1000;
    for (let s of stars.pts) {
      let tw = 0.55 + 0.45 * Math.sin(t * s.sp + s.tw);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${s.a * tw})`;
      ctx.fill();
    }

    // Soft vignette
    let vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.7);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  _drawBackdrop(ctx, w, h) {
    // Opaque base so cross-fades never flash through the canvas clear.
    ctx.fillStyle = '#0a0414';
    ctx.fillRect(0, 0, w, h);

    let mix = this._backdropMix();
    let coverImg = this._coverImage(mix.coverId);
    let coverAlpha = coverImg ? mix.coverAlpha : 0;
    let starAlpha = coverImg ? mix.starAlpha : 1;

    // Travel: cover under stars (stars rise). Settle: stars under cover (cover rises).
    if (mix.starAlpha >= mix.coverAlpha) {
      this._drawCoverBg(ctx, w, h, coverImg, coverAlpha);
      this._drawStarfield(ctx, w, h, starAlpha);
    } else {
      this._drawStarfield(ctx, w, h, starAlpha);
      this._drawCoverBg(ctx, w, h, coverImg, coverAlpha);
    }
  }

  _drawBubble(ctx, n, L, { here, sel, alpha = 1 }) {
    if (!L || alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    let r = L.r;
    let pulse = here ? 1 + 0.045 * Math.sin(performance.now() / 420) : 1;
    let rr = r * pulse;

    // Outer glow
    let glow = ctx.createRadialGradient(L.x, L.y, rr * 0.3, L.x, L.y, rr * 1.85);
    if (here) {
      glow.addColorStop(0, 'rgba(255, 113, 206, 0.55)');
      glow.addColorStop(0.55, 'rgba(255, 113, 206, 0.18)');
      glow.addColorStop(1, 'rgba(255, 113, 206, 0)');
    } else if (sel) {
      glow.addColorStop(0, 'rgba(1, 205, 254, 0.45)');
      glow.addColorStop(0.55, 'rgba(1, 205, 254, 0.14)');
      glow.addColorStop(1, 'rgba(1, 205, 254, 0)');
    } else {
      glow.addColorStop(0, 'rgba(255, 255, 255, 0.16)');
      glow.addColorStop(0.6, 'rgba(255, 255, 255, 0.04)');
      glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    }
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(L.x, L.y, rr * 1.85, 0, Math.PI * 2);
    ctx.fill();

    // Glass disc
    let fill = ctx.createLinearGradient(L.x - rr, L.y - rr, L.x + rr, L.y + rr);
    if (here) {
      fill.addColorStop(0, 'rgba(255, 160, 220, 0.95)');
      fill.addColorStop(0.5, 'rgba(255, 113, 206, 0.88)');
      fill.addColorStop(1, 'rgba(190, 70, 200, 0.92)');
    } else if (sel) {
      fill.addColorStop(0, 'rgba(140, 240, 255, 0.9)');
      fill.addColorStop(1, 'rgba(1, 180, 230, 0.85)');
    } else {
      fill.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
      fill.addColorStop(1, 'rgba(255, 255, 255, 0.08)');
    }
    ctx.beginPath();
    ctx.arc(L.x, L.y, rr, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.lineWidth = here || sel ? Math.max(2.5, rr * 0.08) : Math.max(1.2, rr * 0.05);
    ctx.strokeStyle = here
      ? 'rgba(255,255,255,0.95)'
      : sel
        ? 'rgba(200,250,255,0.95)'
        : 'rgba(255,255,255,0.4)';
    ctx.stroke();

    // Specular highlight
    ctx.beginPath();
    ctx.ellipse(L.x - rr * 0.28, L.y - rr * 0.35, rr * 0.42, rr * 0.22, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fill();

    let img = this._pictures[n.id];
    if (img && img.complete && img.naturalWidth) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(L.x, L.y, rr - 3, 0, Math.PI * 2);
      ctx.clip();
      // object-fit: cover — scale uniformly to fill the circle, crop overflow
      let size = (rr - 3) * 2;
      let iw = img.naturalWidth;
      let ih = img.naturalHeight;
      let scale = Math.max(size / iw, size / ih);
      let dw = iw * scale;
      let dh = ih * scale;
      ctx.drawImage(img, L.x - dw / 2, L.y - dh / 2, dw, dh);
      let veil = ctx.createRadialGradient(L.x, L.y, rr * 0.2, L.x, L.y, rr);
      veil.addColorStop(0, 'rgba(20,8,30,0.15)');
      veil.addColorStop(1, 'rgba(20,8,30,0.55)');
      ctx.fillStyle = veil;
      ctx.fillRect(L.x - rr, L.y - rr, rr * 2, rr * 2);
      ctx.restore();
    }

    ctx.font = `650 ${Math.max(12, rr * 0.4)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let label = n.name || n.id;
    if (label.length > 14) label = label.slice(0, 13) + '…';
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#fff';
    ctx.fillText(label, L.x, L.y);
    ctx.shadowBlur = 0;

    if (n.users?.length) {
      let badgeY = L.y + rr + Math.max(14, rr * 0.28);
      let text = n.users.length + ' here';
      ctx.font = `600 ${Math.max(10, rr * 0.26)}px ui-sans-serif, system-ui, sans-serif`;
      let tw = ctx.measureText(text).width;
      let bw = tw + 14;
      let bh = Math.max(16, rr * 0.38);
      ctx.beginPath();
      ctx.roundRect?.(L.x - bw / 2, badgeY - bh / 2, bw, bh, bh / 2);
      if (!ctx.roundRect) {
        ctx.rect(L.x - bw / 2, badgeY - bh / 2, bw, bh);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillText(text, L.x, badgeY + 0.5);
    }
    ctx.restore();
  }

  _drawEdges(ctx, edges, layout, alpha = 1) {
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    let lw = Math.max(2, (this._canvas?.width || 400) / 280);
    for (let e of edges) {
      let a = layout[e.from];
      let b = layout[e.to];
      if (!a || !b) continue;
      let mx = (a.x + b.x) / 2;
      let my = (a.y + b.y) / 2;
      // Slight outward bow from center
      let { w, h } = this._canvasSize();
      let cx = w / 2;
      let cy = h / 2;
      let ox = mx - cx;
      let oy = my - cy;
      let mag = Math.hypot(ox, oy) || 1;
      let bow = 0.12;
      let qx = mx + (ox / mag) * mag * bow;
      let qy = my + (oy / mag) * mag * bow;

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(qx, qy, b.x, b.y);
      ctx.strokeStyle = 'rgba(255, 150, 220, 0.18)';
      ctx.lineWidth = lw * 3.2;
      ctx.lineCap = 'round';
      ctx.stroke();

      let grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      grad.addColorStop(0, 'rgba(255, 113, 206, 0.75)');
      grad.addColorStop(0.5, 'rgba(200, 180, 255, 0.55)');
      grad.addColorStop(1, 'rgba(1, 205, 254, 0.7)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawTraveler(ctx, tr, w, h) {
    if (!tr) return;
    let rad = Math.max(9, Math.min(w, h) * 0.024);
    let glow = ctx.createRadialGradient(tr.x, tr.y, 0, tr.x, tr.y, rad * 3.2);
    glow.addColorStop(0, 'rgba(255, 245, 160, 0.85)');
    glow.addColorStop(0.45, 'rgba(255, 113, 206, 0.35)');
    glow.addColorStop(1, 'rgba(255, 113, 206, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(tr.x, tr.y, rad * 3.2, 0, Math.PI * 2);
    ctx.fill();

    let ball = ctx.createRadialGradient(tr.x - rad * 0.3, tr.y - rad * 0.3, rad * 0.1, tr.x, tr.y, rad);
    ball.addColorStop(0, '#fff8c8');
    ball.addColorStop(0.55, '#ffe066');
    ball.addColorStop(1, '#22d3ee');
    ctx.beginPath();
    ctx.arc(tr.x, tr.y, rad, 0, Math.PI * 2);
    ctx.fillStyle = ball;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
  }

  _lerpLayout(fromL, toL, t, id) {
    let a = fromL[id];
    let b = toL[id];
    if (a && b) {
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        r: a.r + (b.r - a.r) * t,
      };
    }
    if (b) {
      // Fade in from slightly outside final ring position
      let { w, h } = this._canvasSize();
      let cx = w / 2;
      let cy = h / 2;
      let dx = b.x - cx;
      let dy = b.y - cy;
      let s = 1.18 - 0.18 * t;
      return { x: cx + dx * s, y: cy + dy * s, r: b.r * (0.7 + 0.3 * t) };
    }
    if (a) {
      let { w, h } = this._canvasSize();
      let cx = w / 2;
      let cy = h / 2;
      let dx = a.x - cx;
      let dy = a.y - cy;
      let s = 1 + 0.2 * t;
      return { x: cx + dx * s, y: cy + dy * s, r: a.r * (1 - 0.25 * t) };
    }
    return null;
  }

  _draw() {
    let canvas = this._canvas;
    if (!canvas) return;
    let ctx = canvas.getContext('2d');
    if (!ctx) return;
    let w = canvas.width;
    let h = canvas.height;
    if (w < 2 || h < 2) return;
    ctx.clearRect(0, 0, w, h);
    this._drawBackdrop(ctx, w, h);

    let anim = this._anim;

    if (anim?.phase === 'travel') {
      let layout = anim.fromLayout;
      this._drawEdges(ctx, this.state.edges, layout, 1);
      for (let n of this.state.nodes) {
        let L = layout[n.id];
        this._drawBubble(ctx, n, L, {
          here: n.id === anim.fromId,
          sel: n.id === this.state.selected || n.id === anim.toId,
          alpha: 1,
        });
      }
      this._drawTraveler(ctx, anim.traveler, w, h);
      return;
    }

    if (anim?.phase === 'settle') {
      let t = anim.t ?? 0;
      let fadeOut = 1 - t;
      let fadeIn = t;
      this._drawEdges(ctx, anim.oldEdges, anim.fromLayout, fadeOut * 0.85);
      for (let n of anim.oldNodes) {
        if (n.id === anim.toId) continue;
        let L = this._lerpLayout(anim.fromLayout, anim.toLayout, t, n.id);
        this._drawBubble(ctx, n, L, {
          here: n.id === anim.fromId,
          sel: false,
          alpha: fadeOut,
        });
      }
      this._drawEdges(ctx, anim.newEdges, anim.toLayout, fadeIn);
      for (let n of anim.newNodes) {
        if (n.id === anim.toId) continue;
        let L = this._lerpLayout(anim.fromLayout, anim.toLayout, t, n.id);
        this._drawBubble(ctx, n, L, {
          here: false,
          sel: n.id === this.state.selected,
          alpha: n.id in anim.fromLayout ? 1 : fadeIn,
        });
      }
      let destNode =
        anim.newNodes.find((n) => n.id === anim.toId) ||
        anim.oldNodes.find((n) => n.id === anim.toId);
      if (destNode) {
        let L = this._lerpLayout(anim.fromLayout, anim.toLayout, t, anim.toId);
        this._drawBubble(ctx, destNode, L, {
          here: true,
          sel: true,
          alpha: 1,
        });
      }
      return;
    }

    this._drawEdges(ctx, this.state.edges, this._layout, 1);
    for (let n of this.state.nodes) {
      let L = this._layout[n.id];
      this._drawBubble(ctx, n, L, {
        here: n.id === this.state.here,
        sel: n.id === this.state.selected,
        alpha: 1,
      });
    }
  }
}

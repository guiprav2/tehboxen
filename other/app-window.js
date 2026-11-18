/**
 * Component class factory for Tehboxen app windows.
 *
 * Desktop mounts each window with showDialog(Name, { winId, ...props }). The
 * component instance created here owns a private controller instance (`this.c`)
 * when the app supports several windows, so each window has its own state:
 *
 *   {{this.s.cwd}}                     → this window's controller state
 *   wf-onclick="this.post('goUp')"     → this window's controller action
 *   post('desktop.focusApp', this.winId)
 *
 * Pass no controller class for single-window apps that keep using their global
 * controller (state.<name> / post('<name>.<action>')).
 */
export function appWindow(Ctrl = null) {
  return class AppWindow {
    constructor(props = {}) {
      this.props = props;
      this.winId = props.winId || props.appId;
      this.c = null;
      if (Ctrl) {
        this.c = new Ctrl();
        this.c.winId = this.winId;
        this.c.props = props;
        this.c.init?.(props);
      }
      try {
        rawctrls.desktop?.actions?.registerInstance?.(this.winId, this.c, this);
      } catch {}
    }

    /** This window's controller state. */
    get s() {
      return this.c ? this.c.state : {};
    }

    /** This window's Desktop record (geometry, frameClass, title…). */
    get win() {
      return state.desktop?.wins?.[this.winId] || {};
    }

    /** Like post(), but runs an action on this window's controller. */
    async post(name, ...args) {
      let act = this.c?.actions?.[name];
      if (!act) throw new Error(`Unknown window action: ${this.winId}.${name}`);
      d.update();
      let result = act(...args);
      d.update();
      if (result?.then) {
        result = await result;
        d.update();
      }
      return result;
    }
  };
}

import { appWindow } from '../other/app-window.js';
import ExplorerCtrl from '../controllers/Explorer.js';

/** One Explorer window: owns its own Explorer controller instance (this.c / this.s / this.post). */
export default appWindow(ExplorerCtrl);

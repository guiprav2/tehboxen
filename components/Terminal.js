import { appWindow } from '../other/app-window.js';
import TerminalCtrl from '../controllers/Terminal.js';

/** One Terminal window: owns its own Terminal controller instance (this.c / this.s / this.post). */
export default appWindow(TerminalCtrl);

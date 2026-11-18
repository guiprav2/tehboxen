import { appWindow } from '../other/app-window.js';
import WinZipCtrl from '../controllers/WinZip.js';

/** One WinZip window: owns its own WinZip controller instance (this.c / this.s / this.post). */
export default appWindow(WinZipCtrl);

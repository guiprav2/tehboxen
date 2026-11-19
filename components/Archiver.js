import { appWindow } from '../other/app-window.js';
import ArchiverCtrl from '../controllers/Archiver.js';

/** One Archiver window: owns its own Archiver controller instance (this.c / this.s / this.post). */
export default appWindow(ArchiverCtrl);

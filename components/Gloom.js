import { appWindow } from '../other/app-window.js';
import GloomCtrl from '../controllers/Gloom.js';

/** One Gloom (web browser) window: owns its own Gloom controller instance (this.c / this.s / this.post). */
export default appWindow(GloomCtrl);

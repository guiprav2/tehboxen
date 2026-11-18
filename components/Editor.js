import { appWindow } from '../other/app-window.js';
import EditorCtrl from '../controllers/Editor.js';

/** One Editor window: owns its own Editor controller instance (this.c / this.s / this.post). */
export default appWindow(EditorCtrl);

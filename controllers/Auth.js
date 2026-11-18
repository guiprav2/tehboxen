import { listAccounts, createAccount, login, validateName, validatePassword } from '../other/accounts.js';
import { readSession, hardNavigate } from '../other/session.js';

let BOOT = [
  'Mounted /home (virtual disk)',
  'Started shadow password service',
  'Reached target Relay messaging',
  'Started boxsh login on tty1',
  'Reached target Network (simulated)',
];

export default class Auth {
  state = {
    mode: 'login',
    accounts: [],
    name: '',
    gecos: '',
    password: '',
    confirm: '',
    error: '',
    busy: false,
    ready: false,
    clock: '',
    bootLines: [],
    bootTotal: BOOT.length,
  };

  _clockTimer = null;

  actions = {
    init: async () => {
      // Already logged in → straight to the desktop (not inside the visual editor).
      if (readSession() && !location.pathname.startsWith('/files/')) return this.actions.go();
      this.state.bootLines = [];
      this.actions.tick();
      clearInterval(this._clockTimer);
      this._clockTimer = setInterval(() => {
        this.actions.tick();
        d.update();
      }, 1000);
      BOOT.forEach((line, i) =>
        setTimeout(() => {
          this.state.bootLines = BOOT.slice(0, i + 1);
          d.update();
        }, 140 * (i + 1)),
      );
      try {
        this.state.accounts = await listAccounts();
      } catch (err) {
        this.state.error = 'Virtual disk unavailable: ' + (err?.message || err);
      }
      this.state.mode = this.state.accounts.length ? 'login' : 'create';
      if (this.state.accounts.length === 1) this.state.name = this.state.accounts[0].name;
      this.state.ready = true;
    },

    detach: () => clearInterval(this._clockTimer),

    tick: () => {
      this.state.clock = new Date().toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },

    setMode: (mode) => {
      if (mode === 'login' && !this.state.accounts.length) return;
      this.state.mode = mode;
      this.state.error = '';
      this.state.password = '';
      this.state.confirm = '';
      if (mode === 'create') this.state.name = '';
      else if (this.state.accounts.length === 1) this.state.name = this.state.accounts[0].name;
    },

    pick: (name) => {
      this.state.name = name;
      this.state.error = '';
    },

    submit: async () => {
      if (this.state.busy) return;
      this.state.error = '';
      let name = String(this.state.name || '').trim().toLowerCase();
      this.state.name = name;
      if (this.state.mode === 'create') {
        let err = validateName(name) || validatePassword(this.state.password);
        if (!err && this.state.password !== this.state.confirm) err = 'Passphrases do not match.';
        if (err) {
          this.state.error = err;
          return;
        }
      } else if (!name || !this.state.password) {
        this.state.error = 'Enter your handle and passphrase.';
        return;
      }
      this.state.busy = true;
      d.update();
      try {
        if (this.state.mode === 'create') {
          await createAccount({ name, gecos: this.state.gecos, password: this.state.password });
        }
        await login(name, this.state.password);
        this.state.password = '';
        this.state.confirm = '';
        this.actions.go();
      } catch (err) {
        this.state.error = err?.message || String(err);
        this.state.password = '';
        this.state.confirm = '';
      } finally {
        this.state.busy = false;
      }
    },

    // Full page load so every module re-reads the session (PLAYER / PLAYER_HOME).
    go: () => hardNavigate('desktop.html'),
  };
}

/**
 * Tehboxen kitty CLI — browser port of kittygpt/kitty-cli.js.
 * Uses VFS + createShell instead of Node fs / bash spawn, and xterm-stdio for TTY.
 *
 *   import { startKitty, stopKitty } from './kitty-cli.js';
 *   await startKitty({ term, vfs, shell, argv: [] });
 */
import applyPatch from './applyPatch.js';
import { createXtermStdio } from './xterm-stdio.js';
import Threads from './stream-threads.js';
import KittyReadline from './kitty-readline.js';
import { createShell, formatResult, SHELL_HOME } from './shell.js';
import { createVfsFs } from './vfs.js';
import { getRunReport } from './kittygpt/core.js';

let activeSession = null;

/** VFS path for kitty config under $HOME (no leading slash). */
function kittyHomeDir(home = SHELL_HOME) {
  let h = String(home || SHELL_HOME).replace(/^\/+|\/+$/g, '') || SHELL_HOME;
  return h + '/.kittygpt';
}

/**
 * Parse argv with commander — same interface as kittygpt/kitty-cli.js.
 * State JSON is optional; omit it for ephemeral mode.
 * Returns { opts, fname, help?, error? }.
 */
async function parseKittyCli(argv = []) {
  let { Command } = await import('https://esm.sh/commander@12.1.0');
  let program = new Command();
  let captured = '';
  program
    .name('kitty')
    .description('KittyGPT interactive CLI')
    .argument('[state]', 'JSON file to load/save conversation state')
    .option('--model <model>', 'Model specifier (oai:*, oail:*, xai:*; default $KITTY_DEFAULT_MODEL or xai:grok-4.5)')
    .option(
      '--image-model <model>',
      'Image tool model (oai:*, oail:*, xai:*). Defaults to the chat model',
    )
    .option('--reasoning <level>', 'Reasoning effort: low | medium | high')
    .option('--instructions <file>', 'Path to instructions file')
    .option('--vanilla', 'Disable built-in instructions')
    .option('--no-agentsmd', 'Disables AGENTS.md tracking')
    .option('--system <message...>', 'Add system message(s)')
    .option('--preamble <path...>', 'Preamble message files to load')
    .option('--tools <path...>', 'Tool modules to load')
    .option('--manager <path>', 'Manager module to intercept completions')
    .option('--no-shell', 'Disable shell tool')
    .option('--no-meta', 'Disable meta-null tools')
    .option('--no-automedia', 'Disable automatic media URL expansion')
    .option('--no-stream', 'Disables streaming')
    .option('--no-plan', 'Disable planning tool')
    .option('--no-subagents', 'Disable subagent support')
    .option('--no-images', 'Disable image_analyze and image_edit tools')
    .option('--no-web', 'Disable web_search and web_grep tools')
    .option('--pipe', 'Enables shell piping mode')
    .option(
      '--max-context <k>',
      'Max context window size in kilotokens (default 250)',
      v => {
        let n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error('--max-context must be a positive integer');
        }
        return n;
      },
    )
    .option('--dbg', 'Debug output')
    .exitOverride()
    .configureOutput({
      writeOut: str => {
        captured += str;
      },
      writeErr: str => {
        captured += str;
      },
    });

  try {
    // { from: 'user' } → argv is only user args (no node/script). Do not
    // prepend 'kitty' or it becomes the [state] argument.
    program.parse(Array.isArray(argv) ? argv.map(String) : [], { from: 'user' });
  } catch (err) {
    let code = err?.code || '';
    if (
      code === 'commander.help' ||
      code === 'commander.helpDisplayed' ||
      code === 'commander.version'
    ) {
      return {
        help: captured || program.helpInformation(),
        opts: null,
        fname: null,
      };
    }
    return {
      error: (captured || err?.message || String(err)).trim(),
      opts: null,
      fname: null,
    };
  }

  let opts = program.opts();
  // Commander --no-* flags default the positive name to true.
  if (opts.maxContext == null) opts.maxContext = 250;
  let fname = program.args[0] || null;
  return { opts, fname, help: null, error: null };
}

/** Resolve a user state path against cwd / ~ (VFS, no leading slash). */
function resolveStatePath(raw, cwd, home) {
  if (raw == null || raw === '') return null;
  let text = String(raw);
  let absolute = false;
  if (text === '~' || text.startsWith('~/')) {
    text = (home || SHELL_HOME) + text.slice(1);
    absolute = true;
  } else if (text.startsWith('/')) {
    absolute = true;
    text = text.replace(/^\/+/, '');
  }
  let parts = absolute
    ? []
    : cwd
      ? String(cwd).split('/').filter(Boolean)
      : [];
  if (!text || text === '.') return parts.join('/') || null;
  for (let part of text.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/') || null;
}

function parseEnvText(text) {
  let env = {};
  for (let line of String(text || '').split(/\r?\n/)) {
    let s = line.trim();
    if (!s || s.startsWith('#')) continue;
    let m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(s);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[m[1]] = val;
  }
  return env;
}

async function loadEnv(vfs, home = SHELL_HOME) {
  let envPath = kittyHomeDir(home) + '/.env';
  let text = (await vfs.withLock(envPath, (lease) => vfs.read(envPath, { lease }), { mode: 'r' })) || '';
  let env = parseEnvText(text);
  globalThis.process = globalThis.process || {};
  globalThis.process.env = { ...(globalThis.process.env || {}), ...env };
  return env;
}

function normalizeContextState(state) {
  if (!state || typeof state !== 'object') state = {};
  state.options ||= {};
  state.metatools ||= {};
  state.memory ||= {};
  state.tokenUsage ||= { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let logs = state.logs;
  let windows;
  if (!Array.isArray(logs) || logs.length === 0) windows = [[]];
  else if (Array.isArray(logs[0])) windows = logs.map(w => (Array.isArray(w) ? w : []));
  else windows = [logs];
  if (!windows.length) windows = [[]];
  state.contextLogs = windows;
  state.logs = windows[windows.length - 1];
  return state;
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'k-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * Start an interactive kitty session on an xterm Terminal.
 * Resolves when the user exits (Ctrl-D / exit / quit).
 */
export async function startKitty({
  term,
  vfs,
  shell,
  argv = [],
  onExit,
} = {}) {
  if (!term) throw new TypeError('startKitty requires { term }');
  if (activeSession) {
    await stopKitty();
  }

  let fs = vfs?.list ? vfs : createVfsFs();
  let sh = shell || createShell(fs);
  let home = sh.home || SHELL_HOME;
  let kittyDir = kittyHomeDir(home);
  let stdio = createXtermStdio(term);
  let { stdin: input, stdout: output, dispose: disposeStdio } = stdio;

  let parsed = await parseKittyCli(argv);
  if (parsed.help) {
    output.write(parsed.help.endsWith('\n') ? parsed.help : parsed.help + '\n');
    disposeStdio?.();
    onExit?.();
    return;
  }
  if (parsed.error) {
    output.write(parsed.error + '\n');
    disposeStdio?.();
    onExit?.();
    return;
  }
  let opts = parsed.opts;
  let fname = resolveStatePath(parsed.fname, sh.cwd || '', home);

  // Ensure ~/.kittygpt exists in the VFS (for .env); state JSON is optional.
  try {
    await fs.write(kittyDir + '/.keep', '');
  } catch {}

  await loadEnv(fs, home);
  let env = globalThis.process?.env || {};
  let hasKey = !!(env.XAI_API_KEY || env.OPENAI_API_KEY || env.OPENROUTER_API_KEY);
  if (!hasKey) {
    output.write(
      '\x1b[33mNo API key in ~/.kittygpt/.env\x1b[0m\n' +
        'Create one, e.g.:\n' +
        "  cat > ~/.kittygpt/.env << 'EOF'\n" +
        '  XAI_API_KEY=...\n' +
        '  EOF\n' +
        'Then restart kitty. Shell / apply_patch still work.\n\n',
    );
  }

  let kittyst = null;
  if (fname) {
    try {
      let raw = await fs.read(fname);
      if (raw) kittyst = JSON.parse(raw);
    } catch (err) {
      if (!String(err).includes('JSON')) {
        /* missing file is fine — will create on save */
      } else {
        output.write('Invalid state JSON: ' + fname + '\n');
        disposeStdio?.();
        onExit?.();
        return;
      }
    }
  }
  kittyst = normalizeContextState(
    kittyst || {
      options: {
        // Default model: $KITTY_DEFAULT_MODEL from the shell or ~/.kittygpt/.env.
        model: opts.model || shell?.env?.KITTY_DEFAULT_MODEL || env.KITTY_DEFAULT_MODEL || 'xai:grok-4.5',
        cid: uuid(),
        instructions: null,
        reasoning: opts.reasoning
          ? { effort: opts.reasoning, summary: 'auto' }
          : undefined,
        maxContextK: opts.maxContext || 250,
      },
      metatools: {},
      logs: [[]],
      memory: {},
      tokenUsage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  );
  if (opts.model) kittyst.options.model = opts.model;
  if (!kittyst.options.cid) kittyst.options.cid = uuid();
  globalThis.kittyst = kittyst;

  if (!opts.vanilla && !kittyst.options.instructions) {
    kittyst.options.instructions = [
      'You are KittyGPT running inside Tehboxen.',
      'User home is ~ → /' + home + '. Prefer the shell tool for ls/cat/mkdir/echo and apply_patch for edits.',
      'Config and API keys live in ~/.kittygpt/.',
      'Do not invent OS commands outside the VFS shell builtins.',
    ].join('\n');
  }

  async function saveState() {
    if (!fname) return;
    let windows = kittyst.contextLogs || [kittyst.logs];
    if (!Array.isArray(windows)) windows = [[]];
    if (windows.length && !Array.isArray(windows[0])) windows = [windows];
    windows[windows.length - 1] = kittyst.logs;
    let logs = windows.map(win =>
      (win || []).filter(x => x && !x.instructions && !x.agentsmd),
    );
    while (logs.length > 1 && (!logs.at(-1) || logs.at(-1).length === 0)) logs.pop();
    if (!logs.length) logs = [[]];
    let { contextLogs, ...rest } = kittyst;
    await fs.write(
      fname,
      JSON.stringify(
        {
          ...rest,
          logs,
          tokenUsage: kittyst.tokenUsage || {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          },
        },
        null,
        2,
      ),
    );
  }

  let useThreads = !opts.pipe && output.isTTY && input.isTTY;
  let threads = useThreads ? new Threads(output, { separator: '\n\n' }) : null;
  let interactive = !!threads;
  let currentRepl = null;
  let replOut = output;
  if (threads) {
    currentRepl = threads.open({ line: true });
    replOut = currentRepl;
  }

  let turnReport = () => {};
  let activeReport = msg => {
    let sink = getRunReport();
    (sink || turnReport)(msg);
  };

  function emit(text = '', { before = currentRepl, stderr = false } = {}) {
    text = String(text ?? '');
    if (threads) {
      let s = threads.open({ commitOnEnd: true, before });
      s.write(text);
      s.end();
      return;
    }
    output.write(text + (text.endsWith('\n') ? '' : '\n'));
    void stderr;
  }

  function rotateRepl() {
    if (!threads) return;
    if (currentRepl) {
      let prev = threads.resolve(currentRepl);
      if (prev?.text) threads.commit(currentRepl);
      try {
        currentRepl.end();
      } catch {}
    }
    currentRepl = threads.open({ line: true });
    replOut = currentRepl;
    activePrompter?.setOutput?.(currentRepl);
  }

  function formatShellRunning(cmdline) {
    let prefix = 'Running: ';
    let suffix = ' ...';
    let budget = 64 - prefix.length - suffix.length;
    let cmd = String(cmdline ?? '');
    if (cmd.length > budget) cmd = cmd.slice(0, Math.max(0, budget));
    return prefix + cmd + suffix;
  }

  function formatShellRan(cmdline, exitCode) {
    let prefix = 'Ran: ';
    let suffix = ` (exit ${exitCode})`;
    let budget = 64 - prefix.length - suffix.length;
    let cmd = String(cmdline ?? '');
    if (cmd.length > budget) cmd = cmd.slice(0, Math.max(0, budget - 1)) + '…';
    return prefix + cmd + suffix;
  }

  function tools() {
    let t = { ...kittyst.metatools };

    if (opts.shell) {
      t.shell = {
        description:
          'Run a Bash-style command in the Tehboxen VFS. Pipes, redirects, and heredocs work. Paths are VFS-relative.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout_ms: { type: 'number' },
          },
          required: ['command'],
          additionalProperties: false,
        },
        handler: async ({ command, timeout_ms }) => {
          let cmdline = String(command ?? '');
          if (!cmdline.trim()) throw new Error('command must be a non-empty string');
          activeReport(formatShellRunning(cmdline));
          let result;
          try {
            let runPromise = sh.run(cmdline);
            if (timeout_ms && timeout_ms > 0) {
              result = await Promise.race([
                runPromise,
                new Promise(resolve =>
                  setTimeout(
                    () =>
                      resolve({
                        code: 124,
                        stdout: '',
                        stderr: `[timeout after ${timeout_ms}ms]\n`,
                      }),
                    timeout_ms,
                  ),
                ),
              ]);
            } else {
              result = await runPromise;
            }
          } catch (err) {
            result = { code: 1, stdout: '', stderr: String(err) + '\n' };
          }
          activeReport(formatShellRan(cmdline, result.code));
          let out = formatResult(result);
          return out.length > 1024 * 128
            ? out.slice(0, 1024 * 128) + ' [truncated]'
            : out;
        },
      };
    }

    t.apply_patch = {
      description:
        'Apply a file-oriented patch to the VFS. Pass the full patch text (*** Begin Patch ... *** End Patch).',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string' },
        },
        required: ['patch'],
        additionalProperties: false,
      },
      handler: async ({ patch }) => {
        let body = String(patch ?? '');
        if (!body.trim()) throw new Error('patch must be a non-empty string');
        activeReport(formatShellRunning('apply_patch'));
        try {
          let result = await applyPatch(body, fs, sh.cwd || '');
          activeReport(formatShellRan('apply_patch', 0));
          return Array.isArray(result) ? result.join('\n') : String(result ?? 'ok');
        } catch (err) {
          activeReport(formatShellRan('apply_patch', 1));
          throw err;
        }
      },
    };

    if (opts.plan) {
      t.update_plan = {
        description: 'Updates the task plan.',
        parameters: {
          type: 'object',
          properties: {
            explanation: { type: 'string' },
            plan: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  step: { type: 'string' },
                  status: { type: 'string' },
                },
                required: ['step', 'status'],
              },
            },
          },
          required: ['plan'],
        },
        handler: ({ plan }) => {
          if (!interactive) {
            emit(
              `\nPlan updated:\n` +
                (plan || []).map((x, i) => `- ${i + 1}. ${x.step} [${x.status}]`).join('\n'),
            );
          }
          return 'Plan updated';
        },
      };
    }

    return t;
  }

  let activePrompter = null;
  let stopped = false;

  function prompter({ prompt = '> ', output: rlOutput = output } = {}) {
    let rl = new KittyReadline({
      input,
      output: rlOutput,
      prompt,
      terminal: true,
    });
    let abortController = null;
    let busy = false;
    let resolveLine = null;
    let queued = [];
    let quitting = false;
    let busyLineHandler = null;
    let busyBeforeLineHandler = null;
    let busyAbortHandler = null;
    let busyQuitHandler = null;

    rl.on('beforeLine', () => {
      if (busy && busyBeforeLineHandler) busyBeforeLineHandler();
    });
    rl.on('line', line => {
      let trimmed = line.trim();
      let r = resolveLine;
      resolveLine = null;
      if (r) r(trimmed);
      else if (busy && busyLineHandler) busyLineHandler(trimmed);
      else if (busy) queued.push(trimmed);
    });

    let beginQuit = () => {
      if (quitting) return;
      quitting = true;
      if (busy) {
        busyQuitHandler?.();
        abortController?.abort();
        abortController = null;
        busy = false;
      }
      let r = resolveLine;
      resolveLine = null;
      r?.(null);
    };
    rl.on('EOF', beginQuit);
    rl.on('close', beginQuit);

    let handleSigint = () => {
      if (busy) {
        busyAbortHandler?.();
        abortController?.abort();
        abortController = null;
        busy = false;
        return;
      }
      if (rl.line.length) {
        rl.clearLine();
        rl.prompt();
        return;
      }
      try {
        output.write('\r\x1b[2K');
      } catch {}
      rl.prompt();
    };
    rl.on('SIGINT', handleSigint);

    return {
      setOutput(next) {
        rl.output = next;
      },
      handleSigint,
      ask() {
        if (quitting || rl.closed) return Promise.resolve(null);
        if (queued.length) return Promise.resolve(queued.shift());
        return new Promise(resolve => {
          resolveLine = resolve;
          rl.prompt();
        });
      },
      showPrompt() {
        rl.prompt();
      },
      clearInput() {
        rl.clearLine();
      },
      setInput(text) {
        rl.line = String(text ?? '');
        rl.cursor = rl.line.length;
        rl.prompt();
      },
      startCompletion() {
        abortController = new AbortController();
        busy = true;
        rl.eofAlways = true;
        return abortController;
      },
      endCompletion() {
        abortController = null;
        busy = false;
        rl.eofAlways = false;
        busyLineHandler = null;
        busyBeforeLineHandler = null;
        busyAbortHandler = null;
        busyQuitHandler = null;
      },
      setBusyBeforeLineHandler(fn) {
        busyBeforeLineHandler = typeof fn === 'function' ? fn : null;
      },
      setBusyLineHandler(fn) {
        busyLineHandler = typeof fn === 'function' ? fn : null;
      },
      setBusyAbortHandler(fn) {
        busyAbortHandler = typeof fn === 'function' ? fn : null;
      },
      setBusyQuitHandler(fn) {
        busyQuitHandler = typeof fn === 'function' ? fn : null;
      },
      get quitting() {
        return quitting;
      },
      close() {
        quitting = true;
        resolveLine?.(null);
        resolveLine = null;
        if (!rl.closed) rl.close();
      },
    };
  }

  async function runTurn(text, ctrl) {
    if (opts.agentsmd) {
      try {
        let agentsmd = await fs.read('AGENTS.md');
        if (agentsmd) {
          let iPrev = kittyst.logs.findIndex(x => x.agentsmd);
          let iFirstUser = kittyst.logs.findIndex(x => x.role === 'user');
          let msg = {
            role: 'user',
            content: `<user_instructions>${agentsmd}</user_instructions>`,
            agentsmd: true,
          };
          if (iPrev >= 0) kittyst.logs.splice(iPrev, 1, msg);
          else
            kittyst.logs.splice(
              iFirstUser >= 0 ? iFirstUser : kittyst.logs.length,
              0,
              msg,
            );
        }
      } catch {}
    }

    kittyst.logs.push({ role: 'user', content: text });
    let ac = ctrl.startCompletion();
    if (threads) rotateRepl();

    let agentStream = null;
    let finishAgent = () => {
      if (agentStream) {
        try {
          agentStream.end();
        } catch {}
        agentStream = null;
      }
    };

    try {
      if (!hasKey) {
        emit(
          'No API key configured. Set XAI_API_KEY or OPENAI_API_KEY in ~/.kittygpt/.env',
          { stderr: true },
        );
        return;
      }

      let completion = (await import('./completion.js')).default;
      turnReport = msg => {
        if (!msg) return;
        if (!agentStream && threads) {
          agentStream = threads.open({ commitOnEnd: true, before: currentRepl });
        }
        if (agentStream) agentStream.write('\x1b[2m' + msg + '\x1b[0m\n');
        else emit(msg);
      };

      let reply = await completion(kittyst.logs, {
        model: kittyst.options.model,
        instructions: kittyst.options.instructions,
        reasoning: kittyst.options.reasoning,
        tools,
        signal: ac.signal,
        stream: opts.stream
          ? chunk => {
              if (!agentStream && threads) {
                agentStream = threads.open({
                  commitOnEnd: true,
                  before: currentRepl,
                });
              }
              let textChunk =
                typeof chunk === 'string'
                  ? chunk
                  : chunk?.content || chunk?.delta || '';
              if (textChunk) {
                if (agentStream) agentStream.write(textChunk);
                else output.write(textChunk);
              }
            }
          : undefined,
        report: msg => activeReport(msg),
        cli: true,
      });

      finishAgent();

      // completion may mutate logs in place or return new turns
      if (Array.isArray(reply)) {
        for (let turn of reply) {
          if (turn && !kittyst.logs.includes(turn)) kittyst.logs.push(turn);
        }
      } else if (reply && typeof reply === 'object' && reply.role) {
        kittyst.logs.push(reply);
      }

      let last = [...kittyst.logs].reverse().find(x => x.role === 'assistant');
      if (last && !opts.stream) {
        let msg = Array.isArray(last.content)
          ? last.content
              .map(x =>
                typeof x === 'string'
                  ? x
                  : x.url
                    ? `Media URL: ${x.url}`
                    : JSON.stringify(x),
              )
              .join('\n\n')
          : String(last.content ?? '');
        emit(`\n🤖 ${msg}`);
      } else if (opts.stream) {
        output.write('\n');
      }

      await saveState();
    } catch (err) {
      if (ac.signal.aborted || err?.name === 'AbortError') {
        emit('Aborted.', { stderr: true });
      } else {
        let textErr =
          err?.name === 'ProviderError'
            ? `✖ ${err.message}`
            : String(err?.stack || err);
        emit(textErr, { stderr: true });
      }
    } finally {
      finishAgent();
      turnReport = () => {};
      ctrl.endCompletion();
    }
  }

  let prompt = prompter({ prompt: '> ', output: replOut });
  activePrompter = prompt;

  if (!opts.pipe) {
    emit(fname ? `Now working on: ${fname}` : 'Now working ephemeral.');
  }

  activeSession = {
    stop: async () => {
      stopped = true;
      try {
        prompt.close();
      } catch {}
      try {
        threads?.close?.();
      } catch {}
      try {
        disposeStdio?.();
      } catch {}
      try {
        await saveState();
      } catch {}
      activeSession = null;
      onExit?.();
    },
  };

  try {
    while (!stopped) {
      let text = await prompt.ask();
      if (text == null) break;
      if (!text) continue;
      if (/^(exit|quit|q)$/i.test(text)) break;
      await runTurn(text, prompt);
    }
  } finally {
    try {
      prompt.close();
    } catch {}
    try {
      output.write('\n');
    } catch {}
    try {
      threads?.close?.();
    } catch {}
    try {
      disposeStdio?.();
    } catch {}
    try {
      await saveState();
    } catch {}
    activeSession = null;
    onExit?.();
  }
}

export async function stopKitty() {
  if (activeSession) await activeSession.stop();
}

export default { startKitty, stopKitty };

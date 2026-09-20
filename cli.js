#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { connect, startChrome } = require('./index');

let activeClient;
/** Set by --keep-open, and by a `-` URL slot: both mean "do not close the page on exit". */
let keepPageOpen = false;
let attached = false;

const HELP_TEXT = `
Usage: node cli.js <command> [options] [arguments]

Commands:
  start                         Start Chrome with remote debugging on port 9222
  markdown <url> [destFile]     Extract article content as clean Markdown (GFM)
  dump-forms <url>              Audit all forms, methods, actions, and inputs (inc. hidden)
  dump-storage <url>            Dump localStorage, sessionStorage, and cookies from target URL
  listeners <url> [selector]    Audit event listeners on target selector or 'window'
  search-sources <url> <query>  Search for string/regex across all loaded script bundles
  download-bundle <url> <queryOrId> <destFile>
                                Download matching script bundle to local file
  deobfuscate <url> <queryOrId> [destFile]
                                Deobfuscate & unminify script using webcrack
  unpack <url> <queryOrId> <destDir>
                                Unpack Webpack/Browserify modules into folder
  ast-search <url> <queryOrId> <pattern>
                                Structural AST search using ast-grep (e.g. 'fetch($U, $$$)')
  screenshot <url> [destFile]   Take desktop screenshot (supports --viewport WxH, --fullPage)
  traffic <url> [--json]        Record network & WebSocket traffic during page load
  har <url> [destFile] [--no-bodies]
                                Export the page load as HAR 1.2 (default <host>.har, '-' = stdout)
  eval [expression]             Evaluate JavaScript on the current page (see -f / stdin)
  session <url>                 Open <url> and leave the tab open for later commands

Any <url> may be '-', which means "the tab that is already open": the command skips
navigation and runs against the live page, so a chain like

  node cli.js session https://target.com
  node cli.js search-sources - "sign"
  node cli.js deobfuscate - 4821 out.js

works off a single page load and keeps its scriptIds valid. '-' implies --keep-open.
Recording is per-process, so 'traffic -' / 'har -' capture only from attach onwards; both
say so in their output and take --wait <ms> to record while the open page keeps working.

Options:
  --port <number>               CDP port (default: 9222)
  --json                        Format output as structured JSON
  --keep-open                   Leave the page open on exit instead of closing it
  --wait <ms>                   (traffic/har) keep recording this long before reading
  -f, --file <path>             (eval) read the expression from a file; '-' reads stdin
  --help                        Display this help message
`;

/**
 * Splits global options out of argv so they never land in a positional slot --
 * `eval <expr> --port 9333` used to evaluate the flags as part of the expression.
 * @param {string[]} argv
 * @returns {{ positional: string[], port: number, isJson: boolean, keepOpen: boolean, waitMs: number }}
 */
function parseGlobalOptions(argv) {
  const positional = [];
  let port = 9222;
  let isJson = false;
  let keepOpen = false;
  let waitMs = 0;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keep-open') {
      keepOpen = true;
    } else if (argv[i] === '--wait') {
      waitMs = Number(argv[++i]);
      if (!Number.isInteger(waitMs) || waitMs < 0) {
        throw new Error('--wait must be a non-negative integer number of milliseconds');
      }
    } else if (argv[i] === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Port must be an integer between 1 and 65535');
      }
    } else if (argv[i] === '--json') {
      isJson = true;
    } else {
      positional.push(argv[i]);
    }
  }

  return { positional, port, isJson, keepOpen, waitMs };
}

/**
 * `-` in a URL slot means "whatever tab is already open": skip navigation so the page
 * keeps its login, SPA route and scriptIds. Attaching never closes the page it borrowed.
 * @param {string | undefined} url
 */
function isAttach(url) {
  return url === '-';
}

/** Connects, recording from this moment on; sets `attached` when the URL slot was `-`. */
async function openClient(url, { port, log } = {}) {
  if (isAttach(url)) attached = true;
  return (activeClient = await connect({ port, log }));
}

/** Navigates unless attached to an already-open page. */
async function navigate(client, url, options) {
  if (isAttach(url)) return;
  await client.goto(url, options);
}

/** The common case: connect, then load the target. */
async function openTarget(url, options = {}) {
  const client = await openClient(url, options);
  await navigate(client, url, options.gotoOptions);
  return client;
}

/**
 * Holds the capture open for `--wait` ms and describes the window it covers, because an
 * attached capture starts at attach time: 0 entries there means "not recorded", not "none sent".
 * @returns {Promise<{ startedAt: 'navigation' | 'attach', waitedMs: number, note?: string }>}
 */
async function recordWindow(url, waitMs) {
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  const startedAt = isAttach(url) ? 'attach' : 'navigation';
  const scope = { startedAt, waitedMs: waitMs };
  if (startedAt === 'attach') {
    scope.note =
      `recording began when this command attached, ${waitMs}ms before it read; ` +
      'it covers no traffic from the original page load. Re-run against the URL, or use --wait <ms> while the page works.';
  }
  return scope;
}

/** The URL to report: with `-` the caller does not know it, only the live page does. */
function targetUrl(client, url) {
  return isAttach(url) ? client.page.url() : url;
}

/** Default HAR filename for a URL; an unparseable or blank URL still gets a usable name. */
function harName(url) {
  try {
    return `${new URL(url).hostname || 'capture'}.har`;
  } catch {
    return 'capture.har';
  }
}

/** Reads all of stdin; used for an expression too long or too quote-heavy for one argv slot. */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * The expression for `eval`: from `-f <path>` (`-` = stdin), from piped stdin, or from argv.
 * @param {string[]} rest positional arguments after the command
 * @param {{ isTty?: boolean }} [io] injected so a test can say "interactive" without a real TTY
 * @returns {Promise<string>}
 */
async function readExpression(rest, io = {}) {
  const flagIdx = rest.findIndex((a) => a === '-f' || a === '--file');
  if (flagIdx !== -1) {
    const source = rest[flagIdx + 1];
    if (!source) throw new Error('-f needs a file path (or - for stdin)');
    if (source === '-') return (await readStdin()).trim();
    return (await fs.promises.readFile(path.resolve(source), 'utf8')).trim();
  }
  const inline = rest.join(' ').trim();
  if (inline) return inline;
  // `echo 'expr' | cli.js eval` with no argument: a pipe is unambiguous, a TTY would hang.
  const isTty = io.isTty !== undefined ? io.isTty : Boolean(process.stdin.isTTY);
  if (!isTty) return (await readStdin()).trim();
  return '';
}

/** Releases a client exactly once; the outer `finally` must not repeat the teardown. */
async function release(client, { closePage = !(keepPageOpen || attached) } = {}) {
  if (activeClient === client) activeClient = null;
  if (closePage) await client.closePage().catch(() => {});
  try {
    client.disconnect();
  } catch {}
}

async function main() {
  const argv = process.argv.slice(2);

  if (!argv[0] || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const { positional: args, port, isJson, keepOpen, waitMs } = parseGlobalOptions(argv);
  keepPageOpen = keepOpen;
  const command = args[0];

  switch (command) {
    case 'start': {
      await startChrome({ port });
      break;
    }

    case 'markdown': {
      const url = args[1];
      if (!url) throw new Error('Target URL is required: node cli.js markdown <url>');
      const destFile = args[2] && !args[2].startsWith('--') ? args[2] : null;

      const client = await openTarget(url, { port });
      const article = await client.toMarkdown();

      if (!article) {
        throw new Error('No readable article content found.');
      }

      if (destFile) {
        await fs.promises.writeFile(path.resolve(destFile), article.markdown, 'utf8');
        console.log(`Saved Markdown to: ${path.resolve(destFile)}`);
      } else {
        console.log(article.markdown);
      }

      await release(client);
      break;
    }

    case 'dump-forms': {
      const url = args[1];
      if (!url) throw new Error('Target URL is required: node cli.js dump-forms <url>');

      const client = await openTarget(url, { port });

      const forms = await client.dom.dumpForms();
      const hidden = await client.dom.dumpHiddenInputs();

      const result = { url: targetUrl(client, url), forms, hiddenInputs: hidden };
      console.log(JSON.stringify(result, null, 2));

      await release(client);
      break;
    }

    case 'dump-storage': {
      const url = args[1];
      if (!url) throw new Error('Target URL is required: node cli.js dump-storage <url>');

      const client = await openTarget(url, { port });

      const storage = await client.dom.dumpStorage();
      const cookies = await client.network.getCookies();

      const result = { url: targetUrl(client, url), ...storage, cookies };
      console.log(JSON.stringify(result, null, 2));

      await release(client);
      break;
    }

    case 'listeners': {
      const url = args[1];
      const selector = args[2] && !args[2].startsWith('--') ? args[2] : 'window';
      if (!url) throw new Error('Target URL is required: node cli.js listeners <url> [selector]');

      const client = await openTarget(url, { port });

      const listeners = await client.dom.getEventListeners(selector);
      console.log(JSON.stringify({ target: selector, listeners }, null, 2));

      await release(client);
      break;
    }

    case 'search-sources': {
      const url = args[1];
      const query = args[2];
      if (!url || !query) {
        throw new Error('URL and search query required: node cli.js search-sources <url> <query>');
      }

      const client = await openTarget(url, { port });

      const results = await client.sources.searchInSources(query);
      console.log(JSON.stringify({ query, count: results.length, matches: results }, null, 2));

      await release(client);
      break;
    }

    case 'download-bundle': {
      const url = args[1];
      const queryOrId = args[2];
      const destFile = args[3];
      if (!url || !queryOrId || !destFile) {
        throw new Error('Usage: node cli.js download-bundle <url> <queryOrId> <destFile>');
      }

      const client = await openTarget(url, { port });

      const downloadRes = await client.sources.downloadBundle(queryOrId, destFile);
      console.log(`Successfully downloaded bundle: ${downloadRes.filePath} (${downloadRes.bytesWritten} bytes)`);

      await release(client);
      break;
    }

    case 'deobfuscate': {
      const url = args[1];
      const queryOrId = args[2];
      const destFile = args[3] && !args[3].startsWith('--') ? args[3] : null;
      if (!url || !queryOrId) {
        throw new Error('Usage: node cli.js deobfuscate <url> <queryOrId> [destFile]');
      }

      const client = await openTarget(url, { port });

      const deobf = await client.sources.deobfuscateBundle(queryOrId);
      if (destFile) {
        await fs.promises.writeFile(path.resolve(destFile), deobf.code, 'utf8');
        console.log(`Saved deobfuscated code to: ${path.resolve(destFile)}`);
      } else {
        console.log(deobf.code);
      }

      await release(client);
      break;
    }

    case 'unpack': {
      const url = args[1];
      const queryOrId = args[2];
      const destDir = args[3];
      if (!url || !queryOrId || !destDir) {
        throw new Error('Usage: node cli.js unpack <url> <queryOrId> <destDir>');
      }

      const client = await openTarget(url, { port });

      const unpackRes = await client.sources.unpackBundle(queryOrId, destDir);
      console.log(`Successfully unpacked ${unpackRes.moduleCount} modules to: ${unpackRes.outputDirectory}`);

      await release(client);
      break;
    }

    case 'ast-search': {
      const url = args[1];
      const queryOrId = args[2];
      const pattern = args[3];
      if (!url || !queryOrId || !pattern) {
        throw new Error('Usage: node cli.js ast-search <url> <queryOrId> <pattern>');
      }

      const client = await openTarget(url, { port });

      const astMatches = await client.sources.searchAst(queryOrId, pattern);
      console.log(JSON.stringify({ pattern, count: astMatches.length, matches: astMatches }, null, 2));

      await release(client);
      break;
    }

    case 'screenshot': {
      const url = args[1];
      const destFile = args[2] && !args[2].startsWith('--') ? args[2] : 'screenshot.png';
      if (!url) throw new Error('Target URL is required: node cli.js screenshot <url> [destFile]');

      const vpIdx = args.indexOf('--viewport');
      let width = 1280;
      let height = 800;
      if (vpIdx !== -1) {
        const parts = (args[vpIdx + 1] || '').split('x').map(Number);
        if (parts.length !== 2 || !parts.every((n) => Number.isInteger(n) && n > 0)) {
          throw new Error(`Invalid --viewport value: ${args[vpIdx + 1] || '(missing)'}. Expected WxH, e.g. 1920x1080`);
        }
        [width, height] = parts;
      }

      const client = await openClient(url, { port });
      await client.setViewport({ width, height });
      await navigate(client, url);
      await new Promise((r) => setTimeout(r, 800));

      const fullPage = args.includes('--fullPage');
      await client.screenshot({ path: path.resolve(destFile), fullPage });
      console.log(`Screenshot saved to: ${path.resolve(destFile)} (${width}x${height})`);

      await release(client);
      break;
    }

    case 'traffic': {
      const url = args[1];
      if (!url) throw new Error('Target URL is required: node cli.js traffic <url>');

      const client = await openClient(url, { port });
      client.network.clear();
      client.websocket.clear();

      await navigate(client, url);
      const scope = await recordWindow(url, waitMs);

      const httpTraffic = client.network.getTraffic();
      const wsSockets = client.websocket.getSockets();
      // Non-zero means the buffer overflowed and the oldest items are gone, not that none existed.
      const truncation = {
        droppedRequests: client.network.droppedCount,
        droppedSockets: client.websocket.droppedSockets,
        droppedFrames: wsSockets.reduce((sum, s) => sum + s.droppedFrames, 0),
      };

      if (isJson) {
        console.log(JSON.stringify({ scope, httpTraffic, wsSockets, truncation }, null, 2));
      } else {
        console.log(`\n=== HTTP Requests (${httpTraffic.length}) ===`);
        httpTraffic.forEach((t) => {
          console.log(`[${t.method || 'GET'}] ${t.status || '...'} ${t.url} (${t.resourceType})`);
        });

        console.log(`\n=== WebSocket Connections (${wsSockets.length}) ===`);
        wsSockets.forEach((s) => {
          const dropped = s.droppedFrames ? ` (+${s.droppedFrames} dropped)` : '';
          console.log(`[WS] ${s.url} - State: ${s.state}, Frames: ${s.frames.length}${dropped}`);
        });

        if (truncation.droppedRequests || truncation.droppedSockets || truncation.droppedFrames) {
          console.log(`\n[!] Capture truncated: ${JSON.stringify(truncation)}`);
        }
        if (scope.note) console.log(`\n[!] ${scope.note}`);
      }

      await release(client);
      break;
    }

    case 'har': {
      const includeBodies = !args.includes('--no-bodies');
      const [, url, destArg] = args.filter((a) => a !== '--no-bodies');
      if (!url) throw new Error('Target URL is required: node cli.js har <url> [destFile]');
      // With `-` the target is only known once attached, so the default name waits for the page.
      let destFile = destArg || (isAttach(url) ? null : harName(url));
      const log = destFile === '-' ? console.error : console.log;

      const client = await openClient(url, { port, log });
      if (!destFile) destFile = harName(client.page.url());
      client.network.clear();
      client.websocket.clear();

      // A HAR is read as "the page load"; wait for the network to settle, not just the DOM.
      await navigate(client, url, { waitUntil: 'networkidle2', timeout: 30000 });
      const scope = await recordWindow(url, waitMs);

      // Bodies are drained here, before release() navigates the tab away and Chrome drops them.
      const har = await client.toHar({ includeBodies });
      har.log._scope = scope;
      if (scope.note) har.log.comment = [har.log.comment, scope.note].filter(Boolean).join(' | ');
      const json = JSON.stringify(har, null, 2);

      if (destFile === '-') {
        process.stdout.write(`${json}\n`);
      } else {
        await fs.promises.writeFile(path.resolve(destFile), json, 'utf8');
        const missing = har.log.entries.filter((e) => e.response.content.comment).length;
        console.log(`Saved HAR (${har.log.entries.length} entries) to: ${path.resolve(destFile)}`);
        if (includeBodies && missing) console.log(`[!] ${missing} entries have no body; see content.comment`);
        if (har.log.comment) console.log(`[!] ${har.log.comment}`);
      }

      await release(client);
      break;
    }

    case 'eval': {
      const expression = await readExpression(args.slice(1));
      if (!expression) {
        throw new Error('Expression required: node cli.js eval <expression> | eval -f <file> | eval -f -');
      }

      // eval never navigates, so it is always attached: closing the page would strand the session.
      const client = await openClient('-', { port });
      const result = await client.evaluate(expression);
      console.log(result);

      await release(client);
      break;
    }

    case 'session': {
      const url = args[1];
      if (!url) throw new Error('Target URL is required: node cli.js session <url>');

      const client = await openTarget(url, { port });
      const current = client.page.url();
      console.log(`Page open at: ${current}`);
      console.log(`Title: ${await client.title()}`);
      console.log("Run follow-ups against it with '-' in the URL slot, e.g. node cli.js dump-forms -");

      // The whole point of the command: leave the tab (and its login/route) behind.
      await release(client, { closePage: false });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP_TEXT);
      throw new Error(`Unknown command: ${command}`);
  }
}

// Guarded so the helpers above stay unit-testable: requiring this file must not drive Chrome.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error(`[Error] ${err.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (activeClient) await release(activeClient);
    });
}

module.exports = { parseGlobalOptions, isAttach, harName, readExpression };

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { connect, startChrome } = require('./index');

let activeClient;

const HELP_TEXT = `
Usage: node cli.js <command> [options] [arguments]

Commands:
  start                         Start Chrome with remote debugging on port 9222
  markdown <url> [destFile]     Extract article content as clean Markdown (GFM)
  dump-forms <url>              Audit all forms, methods, actions, and inputs (inc. hidden)
  dump-storage <url>            Dump localStorage and sessionStorage from target URL
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
  eval <expression>             Evaluate JavaScript expression on current page

Options:
  --port <number>               CDP port (default: 9222)
  --json                        Format output as structured JSON
  --help                        Display this help message
`;

/**
 * Splits global options out of argv so they never land in a positional slot --
 * `eval <expr> --port 9333` used to evaluate the flags as part of the expression.
 * @param {string[]} argv
 * @returns {{ positional: string[], port: number, isJson: boolean }}
 */
function parseGlobalOptions(argv) {
  const positional = [];
  let port = 9222;
  let isJson = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') {
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

  return { positional, port, isJson };
}

/** Releases a client exactly once; the outer `finally` must not repeat the teardown. */
async function release(client, { closePage = true } = {}) {
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

  const { positional: args, port, isJson } = parseGlobalOptions(argv);
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

      const client = (activeClient = await connect({ port }));
      await client.goto(url);
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

      const client = (activeClient = await connect({ port }));
      await client.goto(url);

      const forms = await client.dom.dumpForms();
      const hidden = await client.dom.dumpHiddenInputs();

      const result = { url, forms, hiddenInputs: hidden };
      console.log(JSON.stringify(result, null, 2));

      await release(client);
      break;
    }

    case 'dump-storage': {
      const url = args[1];
      if (!url) throw new Error('Target URL is required: node cli.js dump-storage <url>');

      const client = (activeClient = await connect({ port }));
      await client.goto(url);

      const storage = await client.dom.dumpStorage();
      const cookies = await client.network.getCookies();

      const result = { url, ...storage, cookies };
      console.log(JSON.stringify(result, null, 2));

      await release(client);
      break;
    }

    case 'listeners': {
      const url = args[1];
      const selector = args[2] && !args[2].startsWith('--') ? args[2] : 'window';
      if (!url) throw new Error('Target URL is required: node cli.js listeners <url> [selector]');

      const client = (activeClient = await connect({ port }));
      await client.goto(url);

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

      const client = (activeClient = await connect({ port }));
      await client.goto(url);

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

      const client = (activeClient = await connect({ port }));
      await client.goto(url);

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

      const client = (activeClient = await connect({ port }));
      await client.goto(url);

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

      const client = (activeClient = await connect({ port }));
      await client.goto(url);

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

      const client = (activeClient = await connect({ port }));
      await client.goto(url);

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

      const client = (activeClient = await connect({ port }));
      await client.setViewport({ width, height });
      await client.goto(url);
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

      const client = (activeClient = await connect({ port }));
      client.network.clear();
      client.websocket.clear();

      await client.goto(url);

      const httpTraffic = client.network.getTraffic();
      const wsSockets = client.websocket.getSockets();

      if (isJson) {
        console.log(JSON.stringify({ httpTraffic, wsSockets }, null, 2));
      } else {
        console.log(`\n=== HTTP Requests (${httpTraffic.length}) ===`);
        httpTraffic.forEach((t) => {
          console.log(`[${t.method || 'GET'}] ${t.status || '...'} ${t.url} (${t.resourceType})`);
        });

        console.log(`\n=== WebSocket Connections (${wsSockets.length}) ===`);
        wsSockets.forEach((s) => {
          console.log(`[WS] ${s.url} - State: ${s.state}, Frames: ${s.frames.length}`);
        });
      }

      await release(client);
      break;
    }

    case 'eval': {
      const expression = args.slice(1).join(' ');
      if (!expression) throw new Error('Expression required: node cli.js eval <expression>');

      const client = (activeClient = await connect({ port }));
      const result = await client.evaluate(expression);
      console.log(result);

      await release(client, { closePage: false });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP_TEXT);
      throw new Error(`Unknown command: ${command}`);
  }
}

main()
  .catch((err) => {
    console.error(`[Error] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (activeClient) await release(activeClient);
  });

/* eslint-disable no-console */
import { exec } from 'node:child_process';
import { release } from 'node:os';
import chokidar from 'chokidar';
import cors from 'cors';
import { context } from 'esbuild';
import type { Request, Response } from 'express';
import express from 'express';
import { packageOptions } from '../.build/common.js';
import { generateLangium } from '../.build/generateLangium.js';
import { createProjectsRouter, seedProjectsIfEmpty } from './projectsApi.js';
import { defaultOptions, getBuildConfig } from './util.js';
import 'dotenv/config';

/**
 * Open the editor on `pnpm dev`, unless disabled (MERMAID_DEV_OPEN=0) or running
 * under CI (e.g. the e2e harness), where popping a browser would be unwanted.
 */
function openDevBrowser(url: string) {
  if (
    process.env.MERMAID_DEV_OPEN === '0' ||
    (process.env.CI && process.env.MERMAID_DEV_OPEN !== '1')
  ) {
    return;
  }
  const isWsl = /microsoft/i.test(release());
  const cmd = isWsl
    ? `wslview "${url}" || xdg-open "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (error) => {
    if (error) {
      console.warn(`Could not auto-open browser at ${url}: ${error.message}`);
    }
  });
}

const configs = Object.values(packageOptions).map(({ packageName }) =>
  getBuildConfig({
    ...defaultOptions,
    minify: false,
    core: false,
    options: packageOptions[packageName],
  })
);
const mermaidIIFEConfig = getBuildConfig({
  ...defaultOptions,
  minify: false,
  core: false,
  options: packageOptions.mermaid,
  format: 'iife',
});
configs.push(mermaidIIFEConfig);

const contexts = await Promise.all(
  configs.map(async (config) => ({ config, context: await context(config) }))
);

let rebuildCounter = 1;
const rebuildAll = async () => {
  const buildNumber = rebuildCounter++;
  const timeLabel = `Rebuild ${buildNumber} Time (total)`;
  console.time(timeLabel);
  await Promise.all(
    contexts.map(async ({ config, context }) => {
      const buildVariant = `Rebuild ${buildNumber} Time (${Object.keys(config.entryPoints!)[0]} ${config.format})`;
      console.time(buildVariant);
      await context.rebuild();
      console.timeEnd(buildVariant);
    })
  ).catch((e) => console.error(e));
  console.timeEnd(timeLabel);
};

let clients: { id: number; response: Response }[] = [];
function eventsHandler(request: Request, response: Response) {
  const headers = {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
  };
  response.writeHead(200, headers);
  const clientId = Date.now();
  clients.push({
    id: clientId,
    response,
  });
  request.on('close', () => {
    clients = clients.filter((client) => client.id !== clientId);
  });
}

let timeoutID: NodeJS.Timeout | undefined = undefined;

/**
 * Debounce file change events to avoid rebuilding multiple times.
 */
function handleFileChange() {
  if (timeoutID !== undefined) {
    clearTimeout(timeoutID);
  }
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  timeoutID = setTimeout(async () => {
    await rebuildAll();
    sendEventsToAll();
    timeoutID = undefined;
  }, 100);
}

function sendEventsToAll() {
  clients.forEach(({ response }) => response.write(`data: ${Date.now()}\n\n`));
}

async function createServer() {
  await generateLangium();
  await seedProjectsIfEmpty();
  handleFileChange();
  const app = express();
  const port = process.env.MERMAID_PORT ?? 9000;
  chokidar
    .watch('**/src/**/*.{js,ts,langium,yaml,json}', {
      ignoreInitial: true,
      ignored: [/node_modules/, /dist/, /docs/, /coverage/],
    })
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    .on('all', async (event, path) => {
      // Ignore other events.
      if (!['add', 'change'].includes(event)) {
        return;
      }
      console.log(`${path} changed. Rebuilding...`);
      if (path.endsWith('.langium')) {
        await generateLangium();
      }
      handleFileChange();
    });

  app.use(cors());
  app.use(createProjectsRouter());
  app.get('/events', eventsHandler);
  for (const { packageName } of Object.values(packageOptions)) {
    app.use(express.static(`./packages/${packageName}/dist`));
  }
  app.use(express.static('playground'));

  app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`Listening on ${url}`);
    openDevBrowser(url);
  });
}

void createServer();

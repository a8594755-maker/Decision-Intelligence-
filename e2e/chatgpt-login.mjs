#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '.auth');
const STORAGE_STATE_PATH = path.join(AUTH_DIR, 'chatgpt-storage-state.json');
const LOGIN_URL = 'https://chatgpt.com/';

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function promptForCompletion() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('');
    console.log('ChatGPT login window opened.');
    console.log('1. Finish sign-in in the browser window.');
    console.log('2. Wait until the ChatGPT UI is fully visible.');
    console.log('3. Come back to this terminal and press Enter to save the session.');
    console.log('');
    await rl.question('Press Enter after login is complete...');
  } finally {
    rl.close();
  }
}

async function main() {
  ensureDir(AUTH_DIR);

  const browser = await chromium.launch({
    headless: false,
    slowMo: 50,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(2_000);

  try {
    await promptForCompletion();
    await page.waitForTimeout(1_000);
    await context.storageState({ path: STORAGE_STATE_PATH });

    console.log('');
    console.log(`Saved ChatGPT storage state to: ${STORAGE_STATE_PATH}`);
    console.log('This file is ignored by git and stays local to this machine.');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('Failed to create ChatGPT storage state:', error?.message || error);
  process.exitCode = 1;
});

#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE_PATH = path.join(__dirname, '.auth', 'chatgpt-storage-state.json');
const OUTPUT_DIR = path.join(__dirname, 'chatgpt-audit');
const SCREENSHOT_DIR = path.join(OUTPUT_DIR, 'screenshots');
const BASE_URL = 'https://chatgpt.com/';

const VIEWPORTS = {
  desktop: {
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
  },
  mobile: {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
};

const STATES = [
  { id: 'sidebar-open', viewport: 'desktop' },
  { id: 'sidebar-collapsed', viewport: 'desktop' },
  { id: 'new-chat', viewport: 'desktop' },
  { id: 'active-thread', viewport: 'desktop' },
  { id: 'composer-focus', viewport: 'desktop' },
  { id: 'mobile-drawer-open', viewport: 'mobile' },
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function assertStorageState() {
  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    throw new Error(
      `Missing storage state at ${STORAGE_STATE_PATH}. Run "node e2e/chatgpt-login.mjs" first.`
    );
  }
}

async function waitForShell(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2_500);
}

async function gotoChatGPT(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForShell(page);
}

async function clickBySemanticLabel(page, patterns) {
  return page.evaluate((regexSources) => {
    const regexes = regexSources.map((source) => new RegExp(source, 'i'));
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const labelOf = (el) =>
      [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.textContent,
      ]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

    const candidate = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'))
      .filter(isVisible)
      .find((el) => regexes.some((regex) => regex.test(labelOf(el))));

    if (!candidate) return null;
    const label = labelOf(candidate);
    candidate.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return label;
  }, patterns);
}

async function detectSidebarMetrics(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const candidates = Array.from(document.querySelectorAll('aside, nav, [role="navigation"], div'))
      .filter(isVisible)
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.left < window.innerWidth * 0.35 && rect.height > window.innerHeight * 0.45 && rect.width > 120)
      .sort((a, b) => {
        if (a.rect.left !== b.rect.left) return a.rect.left - b.rect.left;
        return b.rect.width - a.rect.width;
      });

    if (candidates.length === 0) return { open: false, width: 0 };
    return {
      open: candidates[0].rect.width >= 180,
      width: Math.round(candidates[0].rect.width),
    };
  });
}

async function ensureSidebarState(page, desiredOpen, fallbackNotes) {
  const before = await detectSidebarMetrics(page);
  if (before.open === desiredOpen) return;

  const clickLabel = await clickBySemanticLabel(page, [
    'sidebar',
    'history',
    'menu',
    'open.*chat',
    'close.*chat',
  ]);

  if (!clickLabel) {
    fallbackNotes.push(`Could not find a sidebar toggle for ${desiredOpen ? 'open' : 'collapsed'} state.`);
    return;
  }

  await page.waitForTimeout(1_000);
  const after = await detectSidebarMetrics(page);
  if (after.open !== desiredOpen) {
    fallbackNotes.push(`Clicked "${clickLabel}" but sidebar did not reach ${desiredOpen ? 'open' : 'collapsed'} state.`);
  }
}

async function openNewChat(page, fallbackNotes) {
  const clicked = await clickBySemanticLabel(page, [
    '^new chat$',
    '^new$',
    'start new chat',
  ]);

  if (clicked) {
    await page.waitForTimeout(1_250);
    return;
  }

  const url = page.url();
  if (url === BASE_URL || /chatgpt\.com\/?$/.test(url)) {
    fallbackNotes.push('Used current landing page as new-chat fallback.');
    return;
  }

  fallbackNotes.push('Could not confirm a dedicated new-chat state; reused current page.');
}

async function openExistingThread(page, fallbackNotes) {
  const clicked = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const candidates = Array.from(document.querySelectorAll('a[href], [role="link"]'))
      .filter(isVisible)
      .map((el) => ({
        el,
        href: el.getAttribute('href') || '',
        label: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      }))
      .find(({ href, label }) => /\/c\/|\/g\/|\/share\//.test(href) || (href.startsWith('/') && label.length > 8));

    if (!candidates) return null;
    candidates.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return candidates.label || candidates.href;
  });

  if (clicked) {
    await page.waitForTimeout(1_500);
    return;
  }

  fallbackNotes.push('Could not find an existing thread link; reused current page as active-thread fallback.');
}

async function focusComposer(page, fallbackNotes) {
  const focused = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const target =
      Array.from(document.querySelectorAll('textarea'))
        .filter(isVisible)[0]
      || Array.from(document.querySelectorAll('[contenteditable="true"]'))
        .filter(isVisible)[0];

    if (!target) return false;
    target.focus();
    return document.activeElement === target;
  });

  if (!focused) {
    fallbackNotes.push('Could not focus the composer element; captured the closest stable thread state instead.');
  }
}

async function collectUiSummary(page, stateId, viewportName, fallbackNotes) {
  return page.evaluate(
    ({ currentState, currentViewport, currentFallbacks }) => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      const text = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const labelOf = (el) =>
        text([
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.textContent,
        ]
          .filter(Boolean)
          .join(' '));

      const sidebarCandidate = Array.from(document.querySelectorAll('aside, nav, [role="navigation"], div'))
        .filter(isVisible)
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.left < window.innerWidth * 0.35 && rect.height > window.innerHeight * 0.45 && rect.width > 120)
        .sort((a, b) => {
          if (a.rect.left !== b.rect.left) return a.rect.left - b.rect.left;
          return b.rect.width - a.rect.width;
        })[0];

      const composer =
        Array.from(document.querySelectorAll('textarea')).filter(isVisible)[0]
        || Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(isVisible)[0]
        || null;
      const composerRect = composer?.getBoundingClientRect() || null;
      const composerStyle = composer ? window.getComputedStyle(composer) : null;

      const topButtons = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'))
        .filter(isVisible)
        .map((el) => ({ el, rect: el.getBoundingClientRect(), label: labelOf(el) }))
        .filter(({ rect, label }) => rect.top < 112 && label.length > 0)
        .slice(0, 8);

      const conversationRows = sidebarCandidate
        ? Array.from(sidebarCandidate.el.querySelectorAll('a, button, [role="button"], [role="link"]'))
          .filter(isVisible)
          .map((el) => ({ el, rect: el.getBoundingClientRect(), label: labelOf(el) }))
          .filter(({ label, rect }) => label.length > 0 && rect.height >= 24 && rect.width > 120)
          .slice(0, 6)
        : [];

      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .filter(isVisible)
        .map((el) => ({ text: text(el.textContent), rect: el.getBoundingClientRect() }))
        .filter((entry) => entry.text.length > 0)
        .slice(0, 5);

      const suggestionCards = Array.from(document.querySelectorAll('button, a'))
        .filter(isVisible)
        .map((el) => ({ label: labelOf(el), rect: el.getBoundingClientRect() }))
        .filter(({ label, rect }) => label.length > 8 && rect.top > (headings[0]?.rect.top || 0) && rect.width > 120)
        .slice(0, 8);

      const composerAncestorWidth = composer
        ? (() => {
            let current = composer.parentElement;
            let best = composerRect?.width || 0;
            while (current) {
              const rect = current.getBoundingClientRect();
              if (rect.width >= best && rect.width <= window.innerWidth && rect.width > 200) {
                best = rect.width;
              }
              current = current.parentElement;
            }
            return Math.round(best);
          })()
        : 0;

      const averageRowHeight = conversationRows.length > 0
        ? Math.round(conversationRows.reduce((sum, row) => sum + row.rect.height, 0) / conversationRows.length)
        : 0;

      return {
        state: currentState,
        viewport: currentViewport,
        page_url: location.href,
        sidebar_width: sidebarCandidate ? Math.round(sidebarCandidate.rect.width) : 0,
        main_content_max_width: composerAncestorWidth,
        header_structure: {
          button_count: topButtons.length,
          labels: topButtons.map((button) => button.label).filter(Boolean),
        },
        composer: composerRect && composerStyle
          ? {
              height: Math.round(composerRect.height),
              border_radius: composerStyle.borderRadius,
              padding_inline: `${composerStyle.paddingLeft} ${composerStyle.paddingRight}`,
              padding_block: `${composerStyle.paddingTop} ${composerStyle.paddingBottom}`,
            }
          : null,
        conversation_density: {
          row_count_sampled: conversationRows.length,
          average_row_height: averageRowHeight,
        },
        primary_action_positions: topButtons.slice(0, 5).map((button) => ({
          label: button.label,
          x: Math.round(button.rect.left),
          y: Math.round(button.rect.top),
        })),
        empty_state_rhythm: {
          headings: headings.map((heading) => heading.text),
          suggestion_count: suggestionCards.length,
          first_heading_top: headings[0] ? Math.round(headings[0].rect.top) : null,
        },
        fallback_notes: currentFallbacks,
      };
    },
    {
      currentState: stateId,
      currentViewport: viewportName,
      currentFallbacks: fallbackNotes,
    }
  );
}

async function captureState(browser, stateDef, report) {
  const context = await browser.newContext({
    ...VIEWPORTS[stateDef.viewport],
    storageState: STORAGE_STATE_PATH,
  });

  const page = await context.newPage();
  const fallbackNotes = [];

  try {
    await gotoChatGPT(page);

    if (stateDef.id === 'sidebar-open') {
      await ensureSidebarState(page, true, fallbackNotes);
    } else if (stateDef.id === 'sidebar-collapsed') {
      await ensureSidebarState(page, false, fallbackNotes);
    } else if (stateDef.id === 'new-chat') {
      await openNewChat(page, fallbackNotes);
    } else if (stateDef.id === 'active-thread') {
      await ensureSidebarState(page, true, fallbackNotes);
      await openExistingThread(page, fallbackNotes);
    } else if (stateDef.id === 'composer-focus') {
      await focusComposer(page, fallbackNotes);
    } else if (stateDef.id === 'mobile-drawer-open') {
      await ensureSidebarState(page, true, fallbackNotes);
    }

    await page.waitForTimeout(1_000);

    const screenshotName = `${stateDef.viewport}-${stateDef.id}.png`;
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, screenshotName),
      fullPage: true,
    });

    const summary = await collectUiSummary(page, stateDef.id, stateDef.viewport, fallbackNotes);
    report.states.push({
      ...summary,
      screenshot: path.join('screenshots', screenshotName),
    });
  } finally {
    await context.close();
  }
}

async function main() {
  assertStorageState();
  ensureDir(SCREENSHOT_DIR);

  const report = {
    generated_at: new Date().toISOString(),
    base_url: BASE_URL,
    storage_state_path: STORAGE_STATE_PATH,
    states: [],
  };

  const browser = await chromium.launch({ headless: true });

  try {
    for (const stateDef of STATES) {
      console.log(`Capturing ${stateDef.id} (${stateDef.viewport})...`);
      await captureState(browser, stateDef, report);
    }
  } finally {
    await browser.close();
  }

  const reportPath = path.join(OUTPUT_DIR, 'chatgpt-ui-summary.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log(`ChatGPT UI audit complete: ${reportPath}`);
  console.log(`Screenshots saved to: ${SCREENSHOT_DIR}`);
}

main().catch((error) => {
  console.error('ChatGPT UI audit failed:', error?.message || error);
  process.exitCode = 1;
});

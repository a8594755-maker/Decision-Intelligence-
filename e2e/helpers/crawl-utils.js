/**
 * Shared utilities for E2E crawling and testing.
 */

const SKIP_BUTTON_TEXT = ['Logout', 'Log out', 'Delete', 'Remove', 'Reset', 'Sign out'];

/**
 * Dismiss any modal/overlay blocking the page (e.g., Getting Started tour).
 */
export async function dismissModals(page) {
  // Wait a moment for modals to appear
  await page.waitForTimeout(500);

  // Close Getting Started tour — try "Skip tour" text first
  const skipTour = page.locator('button:has-text("Skip tour")').first();
  if (await skipTour.isVisible({ timeout: 2000 }).catch(() => false)) {
    await skipTour.click({ force: true });
    await page.waitForTimeout(500);
  }

  // Try any "Skip" button
  const skipBtn = page.locator('button:has-text("Skip")').first();
  if (await skipBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    await skipBtn.click({ force: true });
    await page.waitForTimeout(500);
  }

  // Close any modal via X button (lucide X icon inside button)
  const closeBtn = page.locator('.fixed.inset-0 button svg, [class*="modal"] button[aria-label="Close"]').first();
  if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    await closeBtn.click({ force: true });
    await page.waitForTimeout(300);
  }

  // Press Escape as fallback
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // If overlay still blocks, try clicking outside it
  const overlay = page.locator('.fixed.inset-0.z-50');
  if (await overlay.isVisible({ timeout: 300 }).catch(() => false)) {
    // Click the backdrop edge (top-left corner) to dismiss
    await page.mouse.click(5, 5);
    await page.waitForTimeout(300);
    // Last resort: press Escape again
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
}

/**
 * Navigate to a chat page (/plan, /forecast, /digital-twin) and ensure
 * a conversation is open with the chat input visible.
 * Handles the "No conversations yet" state by clicking "+ New".
 */
export async function openChatPage(page, route = '/plan') {
  await page.goto(route);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  const chatInputSelector = 'textarea[placeholder*="Message"], textarea[placeholder*="message"], textarea:not([placeholder*="Search"])';

  // Check if textarea is already visible
  const alreadyVisible = await page.locator(chatInputSelector).first()
    .isVisible({ timeout: 2000 }).catch(() => false);

  if (!alreadyVisible) {
    // On Command Center ("/"), click "Open Chat" button first
    const openChatBtn = page.locator('button:has-text("Open Chat")').first();
    const openChatVisible = await openChatBtn.isVisible({ timeout: 2000 }).catch(() => false);
    if (openChatVisible) {
      await openChatBtn.click();
      await page.waitForTimeout(2000);
    }

    // Need to create a new conversation — try "New chat" then "New" button
    const newChatBtns = page.locator('button:has-text("New chat")');
    const newChatCount = await newChatBtns.count();
    for (let i = newChatCount - 1; i >= 0; i--) {
      const btn = newChatBtns.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(2000);
        if (await page.locator(chatInputSelector).first().isVisible({ timeout: 2000 }).catch(() => false)) break;
      }
    }

    // Fallback: "+ New" button
    if (!await page.locator(chatInputSelector).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      const newBtn = page.locator('button:has-text("New")').first();
      const newVisible = await newBtn.isVisible({ timeout: 3000 }).catch(() => false);
      if (newVisible) {
        await newBtn.click();
        await page.waitForTimeout(2000);
      }
    }

    // If still not visible, try clicking "Start a new chat" link/text
    if (!await page.locator(chatInputSelector).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      const startChat = page.locator('text=Start a new chat, text=start a new').first();
      const startVisible = await startChat.isVisible({ timeout: 1000 }).catch(() => false);
      if (startVisible) {
        await startChat.click();
        await page.waitForTimeout(2000);
      }
    }
  }

  const chatInput = page.locator(chatInputSelector).first();
  return chatInput;
}

/**
 * Attach error collectors to a page. Call cleanup() when done.
 */
export function collectErrors(page) {
  const errors = [];
  const onConsole = (msg) => {
    if (msg.type() === 'error') errors.push({ type: 'console', text: msg.text() });
  };
  const onPageError = (err) => {
    errors.push({ type: 'pageerror', text: err.message });
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  return {
    errors,
    /** Get filtered errors (excludes benign ResizeObserver) */
    getErrors() {
      return errors.filter((e) => !e.text.includes('ResizeObserver'));
    },
    cleanup() {
      page.removeListener('console', onConsole);
      page.removeListener('pageerror', onPageError);
    },
  };
}

/**
 * Check for error indicators on the page.
 * Returns an array of warning/error objects.
 */
export async function checkErrorIndicators(page) {
  const issues = [];

  // Vite error overlay
  const viteOverlay = await page.locator('#vite-error-overlay').count();
  if (viteOverlay > 0) {
    issues.push({ severity: 'error', msg: 'Vite error overlay detected' });
  }

  // React ErrorBoundary
  const errorBoundary = await page.locator('text=Something went wrong').count();
  if (errorBoundary > 0) {
    issues.push({ severity: 'error', msg: 'React ErrorBoundary crash detected' });
  }

  // Broken images
  const brokenImgs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('img')).filter(
      (img) => img.complete && img.naturalWidth === 0 && img.src,
    ).length;
  });
  if (brokenImgs > 0) {
    issues.push({ severity: 'warning', msg: `${brokenImgs} broken image(s) detected` });
  }

  return issues;
}

/**
 * Discover interactive elements on the page.
 */
export async function discoverInteractiveElements(page) {
  const buttons = await page.locator('button:visible').all();
  const tabs = await page.locator('[role="tab"]:visible').all();
  const inputs = await page.locator('input:visible, textarea:visible').all();
  const selects = await page.locator('select:visible').all();

  return { buttons, tabs, inputs, selects };
}

/**
 * Safely click an element. Returns true if clicked successfully.
 */
export async function safeClick(element, page, { timeout = 2000 } = {}) {
  try {
    const text = (await element.textContent({ timeout: 1000 })) || '';
    if (SKIP_BUTTON_TEXT.some((s) => text.includes(s))) {
      return { clicked: false, skipped: true, text };
    }
    await element.click({ timeout });
    await page.waitForTimeout(500);
    return { clicked: true, skipped: false, text };
  } catch {
    return { clicked: false, skipped: false, text: '' };
  }
}

/**
 * Wait for lazy-loaded page content to appear (Suspense fallback gone).
 */
export async function waitForPageReady(page, { timeout = 8000 } = {}) {
  // Use load state instead of networkidle (Supabase realtime keeps connections open)
  await page.waitForLoadState('load', { timeout }).catch(() => {});
  // Give React time to render lazy-loaded components
  await page.waitForTimeout(1500);
  // Wait for Suspense spinner to disappear
  try {
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="loading"], .animate-pulse'),
      { timeout: 3000 },
    );
  } catch {
    // OK if no spinner found
  }
}

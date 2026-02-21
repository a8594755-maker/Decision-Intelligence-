/**
 * App.jsx — Legacy entry point.
 *
 * All routing, auth, and layout logic has been moved to:
 *   - src/contexts/AuthContext.jsx  (auth state)
 *   - src/contexts/AppContext.jsx   (UI state)
 *   - src/layouts/AppShell.jsx      (layout + nav)
 *   - src/pages/LoginPage.jsx       (login form)
 *   - src/router.jsx                (routes)
 *
 * main.jsx now mounts <RouterProvider> directly. This file is kept only
 * for backward compatibility with any stale imports.
 */
export { default } from './layouts/AppShell';

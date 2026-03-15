/**
 * OpenCloud Web Extension entry point.
 *
 * Uses OpenCloud's `defineWebApplication` API to register the extension
 * within the OpenCloud UI. Falls back to standalone mount for development.
 */

import { createApp } from 'vue';
import App from './App.vue';

// ── OpenCloud Extension Registration ────────────────────────────────────

/**
 * OpenCloud calls `defineWebApplication` from the extension manifest.
 * This function receives the host API and configuration.
 */
export function defineWebApplication({ hostApi, config } = {}) {
  return {
    appInfo: {
      name: 'Decision Intelligence',
      id: 'web-app-decision-intelligence',
      icon: 'bar-chart-2',
    },

    navItems: [
      {
        name: 'Decision Intelligence',
        icon: 'bar-chart-2',
        route: { name: 'decision-intelligence' },
      },
    ],

    routes: [
      {
        name: 'decision-intelligence',
        path: '/decision-intelligence',
        component: App,
        props: { hostApi, config },
      },
    ],

    // Sidebar panel for file context actions
    extensions: {
      sidebarPanels: [
        {
          app: 'decision-intelligence',
          icon: 'bar-chart-2',
          panel: App,
          props: { hostApi, config },
        },
      ],
    },
  };
}

// ── Standalone dev mode ─────────────────────────────────────────────────

if (typeof window !== 'undefined' && !window.__OPENCLOUD_HOST__) {
  const app = createApp(App, {
    config: {
      di_api_url: 'http://localhost:8000',
      supabase_url: '',
      auto_import: false,
    },
  });
  app.mount('#app');
}

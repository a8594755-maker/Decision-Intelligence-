import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import * as Sentry from '@sentry/react'
import { AppProvider } from './contexts/AppContext'
import { AuthProvider } from './contexts/AuthContext'
import { router } from './router'
import './index.css'
import './i18n'
import { warmupEdgeFunction } from './services/ai-infra/aiProxyService'
import { setInferenceFn } from './config/headerSynonyms'
import { inferFieldFromValues } from './utils/fieldPatternInference'

// Wake up Edge Function early so the first AI call doesn't pay cold-start cost
warmupEdgeFunction();

// Wire up pattern inference for header synonyms (avoids circular import)
setInferenceFn(inferFieldFromValues);

const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: import.meta.env.PROD ? 0.2 : 1.0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: import.meta.env.PROD ? 1.0 : 0,
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<p>An error occurred. Please refresh the page.</p>}>
      <AppProvider>
        <AuthProvider>
          <RouterProvider
            router={router}
            future={{ v7_startTransition: true }}
          />
        </AuthProvider>
      </AppProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
)

/**
 * Environment Configuration
 *
 * Centralized config per environment (dev/staging/prod).
 * Reads from VITE_ENV environment variable.
 */

const ENV = import.meta.env?.VITE_ENV || 'development';

const CONFIGS = {
  development: {
    env: 'development',
    logLevel: 'debug',
    mlApiUrl: import.meta.env?.VITE_ML_API_URL || 'http://127.0.0.1:8000',
    enableDevTools: true,
    enableDemoMode: true,
    maxRowsPerSheet: 2_000_000,
    solverMaxSeconds: 90,
    rateLimit: { requestsPerMinute: 100 },
    featureFlags: {
      proactiveAlerts: true,
      riskAware: true,
      scenarioStudio: true,
      opsDashboard: true,
    },
  },

  staging: {
    env: 'staging',
    logLevel: 'info',
    mlApiUrl: import.meta.env?.VITE_ML_API_URL || 'https://staging-ml.example.com',
    enableDevTools: false,
    enableDemoMode: true,
    maxRowsPerSheet: 2_000_000,
    solverMaxSeconds: 120,
    rateLimit: { requestsPerMinute: 60 },
    featureFlags: {
      proactiveAlerts: true,
      riskAware: true,
      scenarioStudio: true,
      opsDashboard: true,
    },
  },

  production: {
    env: 'production',
    logLevel: 'warn',
    mlApiUrl: import.meta.env?.VITE_ML_API_URL || 'https://ml.example.com',
    enableDevTools: false,
    enableDemoMode: false,
    maxRowsPerSheet: 2_000_000,
    solverMaxSeconds: 120,
    rateLimit: { requestsPerMinute: 30 },
    featureFlags: {
      proactiveAlerts: true,
      riskAware: true,
      scenarioStudio: true,
      opsDashboard: true,
    },
  },
};

export const envConfig = CONFIGS[ENV] || CONFIGS.development;
export const isDev = envConfig.env === 'development';
export const isProd = envConfig.env === 'production';
export const isStaging = envConfig.env === 'staging';

export default envConfig;

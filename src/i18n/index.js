/**
 * i18n Configuration for Decision-Intelligence Platform.
 *
 * Languages: English (en), Traditional Chinese (zh-TW)
 * Default: browser language → localStorage → 'en'
 * Namespaces: common, nav, dashboard
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import zhTW from './zh-TW.json';

const savedLang = typeof localStorage !== 'undefined'
  ? localStorage.getItem('di-lang')
  : null;

const browserLang = typeof navigator !== 'undefined'
  ? navigator.language
  : 'en';

// Map browser locale to our supported languages
function resolveLanguage(lang) {
  if (!lang) return 'en';
  const lower = lang.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-TW';
  return 'en';
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      'zh-TW': { translation: zhTW },
    },
    lng: savedLang || resolveLanguage(browserLang),
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  });

// Persist language changes
i18n.on('languageChanged', (lng) => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('di-lang', lng);
  }
});

export default i18n;

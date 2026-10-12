import i18next from 'i18next';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { en } from '../locales/en';
import { fr } from '../locales/fr';
import { pt } from '../locales/pt';

export type Locale = 'pt' | 'en' | 'fr';

const TAGS: Record<Locale, string> = { pt: 'pt-BR', en: 'en', fr: 'fr' };

// O idioma vem só do navegador: o primeiro da lista de preferências que a interface fala; nenhum, inglês.
function browserLocale(): Locale {
  for (const language of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const base = language.toLowerCase().split('-')[0];
    if (base === 'pt' || base === 'en' || base === 'fr') return base;
  }
  return 'en';
}

void i18next.init({
  resources: { pt: { translation: pt }, en: { translation: en }, fr: { translation: fr } },
  lng: browserLocale(),
  fallbackLng: 'pt',
  initAsync: false,
  interpolation: { escapeValue: false },
});

export const t = i18next.t.bind(i18next);

export function currentLocale(): Locale {
  return i18next.language as Locale;
}

// Etiqueta BCP 47 do idioma atual, para Intl e para o Accept-Language das chamadas à API.
export function localeTag(): string {
  return TAGS[currentLocale()] ?? 'pt-BR';
}

// Se o usuário mudar o idioma do navegador com a aba aberta, a interface acompanha: todo texto é lido
// do catálogo durante a renderização, então basta remontar.
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(currentLocale);
  useEffect(() => {
    document.documentElement.lang = localeTag();
  }, [locale]);
  useEffect(() => {
    const onChange = () => {
      const next = browserLocale();
      void i18next.changeLanguage(next);
      setLocale(next);
    };
    window.addEventListener('languagechange', onChange);
    return () => window.removeEventListener('languagechange', onChange);
  }, []);
  return <Fragment key={locale}>{children}</Fragment>;
}

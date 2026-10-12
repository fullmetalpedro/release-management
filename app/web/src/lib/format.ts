import { useEffect, useState } from 'react';
import type { PersonView, ReleaseView } from './api';
import { currentLocale, localeTag, t, type Locale } from './i18n';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]![0]!;
  const last = words.length > 1 ? words.at(-1)![0]! : '';
  return (first + last).toUpperCase();
}

// Idade do PR como no card: 3h, 1d, 6d (em francês, 3 h e 1 j).
export function age(iso: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - new Date(iso).getTime());
  if (elapsed < HOUR) return t('time.ageMinutes', { count: Math.max(1, Math.floor(elapsed / MINUTE)) });
  if (elapsed < DAY) return t('time.ageHours', { count: Math.floor(elapsed / HOUR) });
  return t('time.ageDays', { count: Math.floor(elapsed / DAY) });
}

// Dia e mês no costume de cada idioma: 08/10, Oct 8, 8 oct.
const SHORT_DATE: Record<Locale, Intl.DateTimeFormatOptions> = {
  pt: { day: '2-digit', month: '2-digit' },
  en: { month: 'short', day: 'numeric' },
  fr: { day: 'numeric', month: 'short' },
};

export function shortDate(iso: string | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(localeTag(), SHORT_DATE[currentLocale()]).format(new Date(iso));
}

export function elapsedLabel(iso: string, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - new Date(iso).getTime()) / MINUTE);
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? t('time.hoursAgo', { count: hours }) : t('time.daysAgo', { count: Math.floor(hours / 24) });
}

export function authorLabel(person: PersonView): string {
  return person.isMe ? t('common.you') : person.name;
}

// "Criada em 08/10 por Sam Carter a partir de develop" / "Created just now by you from main".
export function releaseMeta(release: ReleaseView, now = Date.now()): string {
  const parts = [t('releaseMeta.created')];
  if (release.createdAt) {
    const recent = now - new Date(release.createdAt).getTime() < 5 * MINUTE;
    parts.push(recent ? t('releaseMeta.now') : t('releaseMeta.on', { date: shortDate(release.createdAt) }));
  }
  if (release.createdBy) {
    parts.push(release.createdBy.isMe ? t('releaseMeta.byMe') : t('releaseMeta.by', { name: release.createdBy.name }));
  }
  if (release.baseBranch) parts.push(t('releaseMeta.from', { branch: release.baseBranch }));
  return parts.length > 1 ? parts.join(' ') : '';
}

// Reavalia rótulos relativos ("há 2 min") sem refazer nenhuma requisição.
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// `isValid` confere o formato do que estava guardado: uma versão antiga da aplicação (ou outra aba) pode ter
// gravado algo que esta não entende, e aí vale o valor inicial.
export function useStoredState<T>(key: string, initial: T, isValid?: (value: unknown) => value is T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      const stored: unknown = JSON.parse(raw);
      return !isValid || isValid(stored) ? (stored as T) : initial;
    } catch {
      return initial;
    }
  });
  const update = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Sem armazenamento (aba privada): a preferência vale só para esta visita.
    }
  };
  return [value, update];
}

import { useEffect, useState } from 'react';
import type { PersonView, ReleaseView } from './api';

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

// Idade do PR como no card: 3h, 1d, 6d.
export function age(iso: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - new Date(iso).getTime());
  if (elapsed < HOUR) return `${Math.max(1, Math.floor(elapsed / MINUTE))}min`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  return `${Math.floor(elapsed / DAY)}d`;
}

export function shortDate(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function elapsedLabel(iso: string, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - new Date(iso).getTime()) / MINUTE);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `há ${hours} h` : `há ${Math.floor(hours / 24)} d`;
}

export function authorLabel(person: PersonView): string {
  return person.isMe ? 'Você' : person.name;
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

// "Criada em 08/10 por Manoel Martins a partir de develop" / "Criada agora por você a partir de main".
export function releaseMeta(release: ReleaseView, now = Date.now(), capitalize = true): string {
  const parts = [capitalize ? 'Criada' : 'criada'];
  if (release.createdAt) {
    const recent = now - new Date(release.createdAt).getTime() < 5 * MINUTE;
    parts.push(recent ? 'agora' : `em ${shortDate(release.createdAt)}`);
  }
  if (release.createdBy) parts.push(`por ${release.createdBy.isMe ? 'você' : release.createdBy.name}`);
  if (release.baseBranch) parts.push(`a partir de ${release.baseBranch}`);
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

export function useStoredState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
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

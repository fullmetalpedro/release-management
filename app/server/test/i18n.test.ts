import { describe, expect, it } from 'vitest';
import { CherryPickConflictError, ProviderUnavailableError, ValidationError } from '../src/core/domain/errors.ts';
import { localeFrom, msg, render } from '../src/i18n.ts';

describe('idioma das mensagens', () => {
  it('lê o primeiro idioma suportado do Accept-Language; sem nenhum, português', () => {
    expect(localeFrom('fr-FR,fr;q=0.9,en;q=0.8')).toBe('fr');
    expect(localeFrom('de-DE, en-US;q=0.7')).toBe('en');
    expect(localeFrom('pt-BR')).toBe('pt');
    expect(localeFrom('de')).toBe('pt');
    expect(localeFrom(undefined)).toBe('pt');
  });

  it('preenche os parâmetros e mantém o português como mensagem padrão do erro', () => {
    expect(render(msg('branchExists', { branch: 'release/2.16' }), 'fr')).toBe('La branche release/2.16 existe déjà');
    const error = new ValidationError(msg('branchExists', { branch: 'release/2.16' }));
    expect(error.message).toBe('A branch release/2.16 já existe');
    expect(error.messageIn('en')).toBe('Branch release/2.16 already exists');
  });

  it('texto vindo do provedor passa como está, em qualquer idioma', () => {
    const error = new ProviderUnavailableError('github', 'Resource not accessible by integration');
    expect(error.messageIn('fr')).toBe('Resource not accessible by integration');
  });

  it('conflito de cherry-pick também é traduzido', () => {
    expect(new CherryPickConflictError(1274, 'main').messageIn('en')).toBe('Conflict applying #1274 onto main');
  });
});

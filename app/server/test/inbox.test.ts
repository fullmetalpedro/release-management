import { describe, expect, it } from 'vitest';
import { MemorySourceControl } from '../src/adapters/memory/memoryAdapters.ts';
import { createWorld } from '../src/adapters/memory/world.ts';
import { createLimiter } from '../src/core/concurrency.ts';
import { ConnectionExpiredError, NotAuthenticatedError, ProviderUnavailableError } from '../src/core/domain/errors.ts';
import type { SourceControl } from '../src/core/ports/sourceControl.ts';
import { getInbox } from '../src/core/usecases/inbox.ts';

// Adapter de memória em que toda chamada falha com o erro dado.
const failing = (error: () => Error) =>
  new Proxy(new MemorySourceControl(createWorld()), { get: () => async () => { throw error(); } }) as SourceControl;

describe('caixa de entrada', () => {
  it('junta só o que depende de mim, de todas as organizações, com a organização e o projeto em cada item', async () => {
    const inbox = await getInbox([
      { id: 'azure-devops:contoso', provider: 'azure-devops', account: 'contoso', expired: false, sourceControl: new MemorySourceControl(createWorld()) },
      { id: 'github:acme', provider: 'github', account: 'acme', expired: false, sourceControl: new MemorySourceControl(createWorld()) },
    ]);
    expect(inbox.items.length).toBeGreaterThan(0);
    expect(inbox.items.every((item) => item.column === 'dependsOnMe')).toBe(true);
    expect(new Set(inbox.items.map((item) => item.account))).toEqual(new Set(['contoso', 'acme']));
    expect(inbox.items.every((item) => item.project.name && item.connectionId)).toBe(true);
    expect(inbox.connections.map((c) => [c.account, c.status, c.count])).toEqual([
      ['contoso', 'ok', inbox.items.filter((item) => item.account === 'contoso').length],
      ['acme', 'ok', inbox.items.filter((item) => item.account === 'acme').length],
    ]);
  });

  it('uma organização expirada ou fora do ar vira aviso e não derruba as outras', async () => {
    const expired: string[] = [];
    const inbox = await getInbox(
      [
        { id: 'azure-devops:contoso', provider: 'azure-devops', account: 'contoso', expired: false, sourceControl: new MemorySourceControl(createWorld()) },
        { id: 'azure-devops:northwind', provider: 'azure-devops', account: 'northwind', expired: true },
        {
          id: 'azure-devops:fabrikam',
          provider: 'azure-devops',
          account: 'fabrikam',
          expired: false,
          sourceControl: failing(() => new ConnectionExpiredError('azure-devops:fabrikam', 'fabrikam')),
        },
        { id: 'github:acme', provider: 'github', account: 'acme', expired: false, sourceControl: failing(() => new ProviderUnavailableError('github', 'fora do ar')) },
      ],
      { onExpired: (id) => expired.push(id) },
    );
    expect(inbox.connections.map((c) => [c.account, c.status])).toEqual([
      ['contoso', 'ok'],
      ['northwind', 'expired'],
      ['fabrikam', 'expired'],
      ['acme', 'failed'],
    ]);
    expect(inbox.connections[3]!.reason).toBe('fora do ar');
    // Só a que expirou agora é marcada; a que já estava expirada nem chama o provedor.
    expect(expired).toEqual(['azure-devops:fabrikam']);
    expect(inbox.items.every((item) => item.account === 'contoso')).toBe(true);
  });

  it('sessão vencida (sem modo token) não vira aviso: sobe para encerrar a sessão', async () => {
    await expect(
      getInbox([{ id: 'azure-devops:acme', provider: 'azure-devops', account: 'acme', expired: false, sourceControl: failing(() => new NotAuthenticatedError()) }]),
    ).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});

describe('limitador compartilhado', () => {
  it('nunca passa do limite, e quem espera entra na ordem', async () => {
    const limit = createLimiter(3);
    let inFlight = 0;
    let max = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        limit(async () => {
          inFlight++;
          max = Math.max(max, inFlight);
          order.push(i);
          await new Promise((resolve) => setTimeout(resolve, 1 + (i % 3)));
          inFlight--;
        }),
      ),
    );
    expect(max).toBe(3);
    expect(order).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('libera a vaga mesmo quando a tarefa falha', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await limit(async () => 'ok')).toBe('ok');
  });
});

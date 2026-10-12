// Executa `fn` sobre os itens com no máximo `limit` chamadas em andamento, preservando a ordem.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const locks = new Map<string, Promise<unknown>>();

// Executa `fn` sozinha para a chave: chamadas simultâneas com a mesma chave esperam a anterior terminar. Vale dentro
// deste processo, o bastante para duas requisições não fazerem a mesma verificação antes de qualquer uma escrever.
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.catch(() => undefined);
  locks.set(key, settled);
  try {
    return await run;
  } finally {
    if (locks.get(key) === settled) locks.delete(key);
  }
}

const MAX_TRACKED_KEYS = 10_000;

// Janela fixa por chave (o IP de quem chama). Basta para as rotas de entrada, que são as únicas abertas a quem
// não tem sessão e que custam uma chamada ao provedor a cada tentativa.
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  // Conta a tentativa e diz se ela cabe na janela. Quando não cabe, `retryAfterSeconds` diz quanto esperar.
  take(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      if (this.windows.size >= MAX_TRACKED_KEYS) this.prune(now);
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return { allowed: window.count <= this.limit, retryAfterSeconds: Math.ceil((window.resetAt - now) / 1000) };
  }

  private prune(now: number) {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    // Sob inundação de chaves ainda válidas, descarta as mais antigas para a memória não crescer sem limite.
    for (const key of this.windows.keys()) {
      if (this.windows.size < MAX_TRACKED_KEYS) break;
      this.windows.delete(key);
    }
  }
}

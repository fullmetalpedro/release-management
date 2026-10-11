import { EntraIdentityProvider } from './adapters/entra/identityProvider.ts';
import { buildServer } from './adapters/http/server.ts';
import { SessionStore } from './adapters/session/sessionStore.ts';
import { loadConfig } from './config.ts';
import { ConnectionRegistry } from './registry.ts';

const config = loadConfig();
const sessions = new SessionStore(config.sessionSecret, config.sessionFile);
const identityProvider = config.entra ? new EntraIdentityProvider(config.entra) : undefined;
const registry = new ConnectionRegistry(config, sessions, identityProvider);

const app = await buildServer({ config, sessions, registry, identityProvider });
await app.listen({ port: config.port, host: config.host });

const methods = config.demo ? 'demonstração' : config.entra ? 'Microsoft e token pessoal' : 'token pessoal';
console.log(`API em http://localhost:${config.port} · entrada por ${methods}`);
if (!config.demo && !config.sessionFile) {
  console.log('Sem SESSION_SECRET: as sessões não são gravadas e caem a cada restart.');
}

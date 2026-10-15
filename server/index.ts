import { existsSync } from 'node:fs'
import { createDeps, createHttpServer } from './app'
import { ConfigError, loadConfig } from './config'

// Ponto de entrada: `npm run server`. Lê o .env da raiz (se existir), valida
// a configuração e escuta só no próprio computador.

if (existsSync('.env')) process.loadEnvFile('.env')

try {
  const config = loadConfig()
  const deps = createDeps(config)
  const server = createHttpServer(deps)

  server.listen(config.port, config.host, () => {
    const host = config.host.includes(':') ? `[${config.host}]` : config.host
    console.log(`Backend do gerador ouvindo em http://${host}:${config.port} (somente este computador)`)
    console.log(
      config.mode === 'openai'
        ? 'Modo: OPENAI — chamadas reais e PAGAS, sempre com confirmação de custo na interface.'
        : 'Modo: SIMULADO — nenhuma chamada à OpenAI, nada é cobrado.',
    )
    console.log(
      `Limites: ${config.maxRequestsPerMinute} req/min, ${config.maxConcurrent} simultâneas, ` +
        `${config.dailyImageLimit} imagens/dia, US$ ${config.dailyBudgetUsd.toFixed(2)}/dia, US$ ${config.maxCostPerJobUsd.toFixed(2)}/geração.`,
    )
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE' ? `A porta ${config.port} já está em uso. Feche o outro processo ou mude PORT no .env.` : err.message)
    process.exit(1)
  })
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuração inválida: ${err.message}`)
    process.exit(1)
  }
  throw err
}

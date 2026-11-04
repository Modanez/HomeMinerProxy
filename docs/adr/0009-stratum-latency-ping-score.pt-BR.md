# ADR-0009: Medição de Latência Stratum (Ping) e Classificação por Score de Qualidade

[English](0009-stratum-latency-ping-score.md) · **Português**

- **Status:** Aceita
- **Data:** 2026-11-04

## Contexto

Na mineração solo de Bitcoin, a latência de rede (RTT / ping) entre o minerador e o servidor Stratum da pool é um fator crítico para a eficiência da fazenda.
- Quando um novo bloco é minerado na rede Bitcoin, a pool envia um novo template de trabalho (`mining.notify` com flag `clean_jobs`).
- Shares calculados e enviados com base no trabalho anterior são descartados como inválidos ("stale shares" ou "job not found").
- Uma latência elevada com a pool aumenta substancialmente a taxa de shares rejeitados e a chance de perder blocos, além de indicar instabilidade da conexão residencial com pools no exterior.
- Operadores de fazendas domésticas precisam de visibilidade direta e intuitiva sobre o tempo de resposta das pools em milissegundos e um score fácil de interpretar.

## Decisão

1. **Medição Contínua em Tempo Real (`src/proxy.js`)**:
   - **Handshake TCP Inicial & Probes de Saúde**: O proxy calcula o tempo de conexão TCP (`pingMs = Date.now() - connectStart`) durante o handshake inicial e durante as sondagens periódicas (`probe(u)`).
   - **Submissão de Shares (`mining.submit`)**: Ao despachar uma submissão de share (`mining.submit`), o proxy registra a marcação temporal `at: Date.now()`. Quando a pool responde com `result: true` ou erro, o Round-Trip Time (`rtt = Date.now() - p.at`) é medido com precisão milimétrica e atribuído ao upstream e ao worker correspondente.
2. **Classificação em Score de Qualidade (`src/stratum.js: pingScore(ms)`)**:
   - 🟢 **Ótimo (`great`, <= 100 ms)**: Latência ideal para mineração solo. Propagação quase instantânea de novos templates de bloco, com risco residual de stale shares (< 0.1%).
   - 🟡 **Bom (`good`, 101 ms a 250 ms)**: Latência aceitável para conexões residenciais com servidores Stratum localizados em outros continentes (ex.: EUA ou Europa).
   - 🔴 **Ruim (`poor`, > 250 ms)**: Latência crítica ou instável. Aumenta probabilidade de submissões rejeitadas por stale share.
3. **Exposição em Camadas**:
   - **API Proxy (`/stats`)**: Cada upstream e rota expõe `pingMs` e `pingScore`, bem como os totais agregados da fazenda.
   - **API Painel (`/api/mining` e `/api/widget`)**: O objeto `proxy` inclui `pingMs` e `pingScore`. O endpoint de widget KWGT expõe o ping formatado `ping` e `pingScore`.
   - **Interface Web**: Linha de status da rede exibe a latência em tempo real e o badge colorido correspondente.
   - **Bot Telegram**: Comando `/status` exibe o ping atual e score quando a fazenda minera através do proxy.

## Consequências

- **Positivas:**
  - Diagnóstico proativo de lentidão de rede antes que cause perda expressiva de shares aceitos.
  - Avaliação imediata ao alternar portas/pools (ex.: comparar latência da pool dos EUA vs Europa).
  - Score visual padronizado e intuitivo (ótimo, bom, ruim) em todas as interfaces (Web, Telegram, Widget, JSON).
- **Negativas / Trade-offs:**
  - Adiciona armazenamento de 1 timestamp por submit pendente na tabela em memória da sessão (custo computacional e de memória desprezível).


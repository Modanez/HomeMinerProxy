# ADR-0002: Proxy Stratum V1 Transparente 1:1 com Seleção de Pool por Porta e Failover

[English](0002-transparent-stratum-proxy-and-failover.md) · **Português**

- **Status:** Aceita
- **Data:** 2026-11-02

## Contexto

Fazendas caseiras de mineração solo combinam aparelhos muito diferentes (NerdMiner/ESP32 a ~100 kH/s, `cpuminer` a ~5 MH/s, ASICs Bitaxe a ~1 TH/s) em várias pools (`public-pool`, `solo.ckpool`, `nerdminers`, `AtlasPool`, `OCEAN`).
- As APIs REST das pools costumam atrasar, cair, esconder workers inativos e não informam o hash nem a dificuldade exata de cada share em tempo real.
- Proxies Stratum agregadores tradicionais reescrevem o `extranonce` ou o usuário da pool, o que inviabiliza misturar ESP32 (dificuldade < 1) com ASICs (dificuldade >= 1000) ou obriga todos a usarem a mesma pool.

## Decisão

1. **Repasse Transparente 1:1 (`src/proxy.js`)**: Cada conexão TCP de um minerador abre uma conexão TCP dedicada 1:1 com a pool. Todas as mensagens JSON-RPC (`mining.subscribe`, `mining.configure`, `mining.authorize`, `mining.notify`, `mining.submit`) passam **sem nenhuma alteração**.
2. **Seleção de Pool pela Porta**: A porta local escolhe a pool de destino (`3333` -> `public-pool`, `3334` -> `ckpool EUA`, `3335` -> `nerdminers`, `3337` -> `OCEAN`, `3338` -> `atlaspool`, `3339` -> `ckpool UE`), configurável via `PROXY_ROUTES`.
3. **Reconstrução Passiva do Cabeçalho (`src/stratum.js`)**: No caminho, o proxy observa o `extranonce1`, a máscara `version-rolling.mask` e os parâmetros do `mining.notify`, remontando o cabeçalho de 80 bytes do bloco a cada `mining.submit` para calcular o hash exato e a dificuldade atingida (`DIFF1 / hash`).
4. **Failover e Failback Automáticos**: Cada porta pode listar pools `backup`. Se a pool principal não responder dentro de `PROXY_CONNECT_TIMEOUT_MS`, o proxy conecta na primeira reserva disponível e reenvia as mensagens iniciais enfileiradas do minerador. Uma checagem periódica (`PROXY_HEALTH_MS`, 60s) testa as pools fora do ar e, quando a principal volta, encerra as sessões na reserva para que os mineradores reconectem na principal.

## Consequências

- **Positivas:**
  - Compatível com qualquer minerador e qualquer pool Stratum V1, mantendo o endereço de pagamento original (`endereco.worker`) enviado pelo aparelho.
  - Visibilidade instantânea de cada share, hash de 64 caracteres, contagem de zeros à esquerda e histograma estatístico de sorte.
  - Failover automático mesmo para aparelhos simples (como ESP32/NerdMiner) que não têm failover confiável no firmware.
- **Negativas / Trade-offs:**
  - Abre uma conexão TCP na pool para cada minerador em vez de multiplexar vários aparelhos num único socket (irrelevante para fazendas caseiras com 1 a 20 aparelhos).


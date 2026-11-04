# ADR-0007: Cliente MQTT 3.1.1 Nativo e Home Assistant Auto-Discovery

[English](0007-mqtt-and-home-assistant-discovery.md) · **Português**

- **Status:** Aceita
- **Data:** 2026-11-04
- **Relacionadas:** [ADR-0001](0001-zero-dependency-nodejs.pt-BR.md), [ADR-0003](0003-flat-json-persistence-and-settings-overlay.pt-BR.md)

## Contexto
Mineradores solo caseiros costumam rodar o **Home Assistant** (ou Mosquitto MQTT) na mesma rede local para controlar tomadas inteligentes (Sonoff, Shelly, Tuya), fitas de LED RGB (WLED, Hue, Nanoleaf), relógios matriciais de mesa (Ulanzi TC001 / AWTRIX 3), caixas de som inteligentes e inversores solares.

Expor a telemetria da fazenda, o consumo elétrico, o líder do campeonato semanal e os eventos em tempo real (novo recorde da fazenda, minerador parado, failover de pool, conquista desbloqueada) no Home Assistant permite criar automações físicas na casa sem precisar configurar sensores HTTP manuais em YAML.

Ao mesmo tempo, a [ADR-0001](0001-zero-dependency-nodejs.pt-BR.md) exige zero dependências `npm` de terceiros (`node_modules`) para que o projeto rode apenas com o binário `node` do sistema.

## Decisão
Implementamos um cliente **MQTT 3.1.1 nativo** (usando apenas `net` e `tls` do Node.js) e o gerador de **Home Assistant MQTT Auto-Discovery** em [`src/mqtt.js`](../../src/mqtt.js):

1. **Protocolo Binário MQTT 3.1.1 Zero-Dependências (`src/mqtt.js`):**
   - Implementa a codificação de inteiros de tamanho variável (`encodeVarInt`), strings UTF-8 prefixadas por tamanho (`encodeStr`), pacote `CONNECT` (com usuário/senha e *Last Will & Testament* `offline` em `<prefixo>/availability`), validação de `CONNACK`, `PUBLISH` (QoS 0, com ou sem `retain`), `PINGREQ` keep-alive e `DISCONNECT`.
   - Suporta tanto TCP puro (`mqtt://host:1883`) quanto TLS (`mqtts://host:8883`), com reconexão automática se o broker reiniciar.
2. **Home Assistant Auto-Discovery (`homeassistant/.../config`):**
   - Ao conectar, publica mensagens retidas de descoberta para 11 sensores (`hashrate`, `best_difficulty`, `best_worker`, `workers_active`, `workers_stopped`, `shares_today`, `power_watts`, `energy_kwh_month`, `cost_month`, `weekly_leader`, `achievements_unlocked`) e 1 sensor binário (`pool_failover`) agrupados num único dispositivo (`Fazenda de Mineração` / `Mining Farm`).
   - Inclui `device_class: power`, `energy` e `monetary` para integração direta com o **Painel de Energia do Home Assistant**.
3. **Estado, Tópicos por Worker e Eventos Instantâneos:**
   - Publica `<prefixo>/state` (JSON retido) e `<prefixo>/worker/<nome>` (JSON retido por worker ativo) a cada ciclo.
   - Reaproveita `digest()` e `diffEvents()` de [`src/telegram.js`](../../src/telegram.js) para publicar eventos instantâneos (sem `retain`) em `<prefixo>/event` (`farm_record`, `personal_record`, `worker_offline`, `worker_online`, `pool_failover`, `pool_recovered`, `wallet_received`, `block_found`, `achievement_unlocked`).
4. **Configuração pela Tela e Mascaramento de Senha (`src/settings.js`):**
   - `MQTT_URL`, `MQTT_USER`, `MQTT_PASS` (mascarada com `type: 'secret'`) e `MQTT_TOPIC` podem ser editados em `/config`, com botão **"Testar MQTT"** (`POST /api/config/test` com `what: "mqtt"`).

## Consequências
- **Positivas:**
  - Zero dependências `npm` preservado.
  - Configuração zero-YAML no Home Assistant: o dispositivo da fazenda e as 12 entidades aparecem sozinhos assim que `MQTT_URL` é preenchido.
  - Automações residenciais (tomadas inteligentes, luzes RGB, avisos por voz, mineração com excedente solar) podem reagir na hora a `<prefixo>/event` ou acompanhar `<prefixo>/state`.
- **Negativas / Trade-offs:**
  - Publica em QoS 0 (*fire-and-forget* sobre TCP/TLS), o que é ideal para telemetria em rede local e mantém a máquina de estados enxuta (< 350 linhas).


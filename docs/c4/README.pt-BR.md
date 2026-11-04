# 🏗️ Arquitetura — Modelo C4 (HomeMinerProxy)

[English](README.md) · **Português**

Este documento descreve a arquitetura do **HomeMinerProxy** utilizando o **Modelo C4** (Contexto, Contêineres, Componentes e Fluxos Dinâmicos).

---

## Nível 1 — Contexto do Sistema (C1)

No nível mais alto, o **HomeMinerProxy** roda num pequeno servidor doméstico (Odroid, Raspberry Pi, host Docker ou qualquer Linux) entre os aparelhos de mineração da casa e as pools/APIs externas de Bitcoin, transformando a mineração solo numa experiência visual e interativa.

```mermaid
flowchart TB
    User["👤 Minerador Caseiro\n(Navegador, Celular, TV Kiosk)"]
    Miners["⛏️ Mineradores\n(Bitaxe, NerdMiner, ESP32, cpuminer)"]

    subgraph HomeLAN["Rede Local (LAN)"]
        HMP["🏠 HomeMinerProxy\n(Proxy Stratum V1, Painel Web,\nBot do Telegram e Placar do Cubo)"]
        Cube["🟦 Cubo GeekMagic SmallTV\n(Tela HTTP 240×240)"]
        Siren["🚨 Sirene USB Arduino\n(Serial /dev/ttyACM0)"]
        KWGT["📱 Widget KWGT Android\n(Leitor HTTP JSON)"]
        MQTT["🏠 Home Assistant / Broker MQTT\n(Mosquitto TCP/TLS 1883/8883)"]
    end

    subgraph External["Serviços Externos na Internet"]
        Pools["🌐 Pools de Mineração Stratum V1\n(public-pool, ckpool EUA/UE,\nnerdminers, AtlasPool, OCEAN)"]
        PoolAPIs["📊 APIs REST das Pools\n(public-pool, ckpool, nerdminers, OCEAN)"]
        BitcoinAPIs["₿ APIs da Rede Bitcoin e Mercado\n(mempool.space, CoinGecko, Binance)"]
        TelegramAPI["✈️ API de Bots do Telegram\n(api.telegram.org)"]
        TuyaAPI["🔌 SmartLife / Tuya OpenAPI v1.0\n(openapi.tuyaus.com / tuyaeu.com)"]
    end

    Miners <-->|"Stratum V1 sobre TCP\n(portas 3333–3335, 3337–3339)"| HMP
    HMP <-->|"Stratum V1 sobre TCP\n(repassa 1:1 + failover)"| Pools
    HMP -->|"HTTPS GET (JSON)"| PoolAPIs
    HMP -->|"HTTPS GET (blocos, dif., carteira, preço)"| BitcoinAPIs
    HMP <-->|"HTTPS Long Polling e Avisos\n(sendMessage / sendPhoto)"| TelegramAPI
    HMP <-->|"HTTPS HMAC-SHA256\n(Watts/Volts reais e liga/desliga)"| TuyaAPI
    HMP -->|"HTTP POST JPEG (/doUpload)"| Cube
    HMP -->|"Serial 9600 baud (R/P/S/T/0/1/2)"| Siren
    User <-->|"HTTP (porta 3000)\nPainel e /config"| HMP
    KWGT -->|"HTTP GET /api/widget"| HMP
    HMP -->|"MQTT 3.1.1 (Auto-Discovery,\nstate, worker/* e event)"| MQTT
```

### Atores e Sistemas Externos
| Ator / Sistema | Protocolo | Papel |
|---|---|---|
| **Minerador Caseiro (Usuário)** | HTTP (`:3000`), Telegram | Acompanha o painel (computador, celular ou `?kiosk`), altera opções em `/config` e conversa com o bot do Telegram. |
| **Mineradores (Hardware)** | Stratum V1 TCP (`:3333–3339`) | Bitaxe, NerdMiner, ESP32 ou `cpuminer` (`minerd`) conectando-se ao servidor da casa em vez de direto na pool. |
| **Pools Stratum V1** | Stratum V1 TCP | Pools solo ou compartilhadas (`public-pool.io`, `solo.ckpool.org`, `eusolo.ckpool.org`, `pool.nerdminers.org`, `solo.atlaspool.io`, `mine.ocean.xyz`). |
| **APIs REST das Pools** | HTTPS JSON | Consulta complementar para workers que não passam pelo proxy ou para saldos da pool. |
| **APIs de Bitcoin e Mercado** | HTTPS JSON | `mempool.space` (últimos blocos, ajuste de dificuldade, taxas, histórico de dificuldade, saldo da carteira) e `CoinGecko` / `Binance` (cotação BTC/BRL e BTC/USD). |
| **API do Telegram** | HTTPS JSON / Multipart | Recebe comandos via *long polling* (`getUpdates`) e envia alertas e o PNG diário do bilhete de loteria (`sendMessage`, `sendPhoto`). |
| **Cubo GeekMagic SmallTV** | HTTP (`:80`) | Display de mesa 240×240 atualizado a cada 5 minutos (ou na hora quando sai novo recorde da fazenda) via upload JPEG. |
| **Sirene USB Arduino** | Serial USB (`9600 8N1`) | Toca melodias e controla os LEDs de estado (verde/amarelo/vermelho) a partir de comandos de 1 byte. |
| **Widget KWGT Android** | HTTP JSON (`:3000/api/widget`) | Lê as métricas resumidas e já formatadas pela rede Wi-Fi de casa ou VPN. |
| **Home Assistant / Broker MQTT** | MQTT 3.1.1 (`:1883` / `:8883`) | Recebe as entidades de Auto-Discovery (`homeassistant/.../config`), o estado da fazenda (`<prefixo>/state`), o estado de cada worker (`<prefixo>/worker/*`) e os eventos instantâneos (`<prefixo>/event`). |
| **SmartLife / Tuya OpenAPI v1.0** | HTTPS JSON (`HMAC-SHA256`) | Lê Watts, Volts, corrente (mA) e estado (ligada/desligada) de uma tomada inteligente SmartLife / Tuya a cada 30s e permite ligar, desligar ou reiniciar a tomada via `/tomada` ou watchdog automático. |

---

## Nível 2 — Contêineres (C2)

O **HomeMinerProxy** é composto por três serviços leves (gerenciados por `systemd` ou `docker compose`), um utilitário de linha de comando sob demanda e persistência em arquivos JSON locais.

```mermaid
flowchart TB
    Miners["⛏️ Mineradores"]
    User["👤 Navegador / Kiosk / KWGT"]
    Pools["🌐 Pools Stratum"]
    ExtAPIs["🌍 mempool.space / APIs de Pools / CoinGecko"]
    TgAPI["✈️ API do Telegram"]
    CubeHW["🟦 Cubo GeekMagic"]
    Arduino["🚨 Sirene Arduino"]

    subgraph Server["Servidor HomeMinerProxy (Linux / systemd ou Docker)"]
        Proxy["⚙️ Proxy Stratum\n(Node.js · src/proxy.js)\nPortas 3333–3339, 127.0.0.1:3336"]
        Painel["🖥️ Painel Web e Bot\n(Node.js · src/painel.js)\nPorta 3000"]
        Ticket["🎟️ Gerador de Bilhete\n(Python 3 + Pillow · src/ticket.py)\nSubprocesso CLI sob demanda"]
        Cubo["🧊 Serviço do Cubo\n(Python 3 + Pillow · src/cubo.py)\nDaemon em segundo plano"]
        EnvFile[("📄 /etc/mineracao.env\nConfiguração Base")]
        DataDir[("💾 DATA_DIR (Arquivos JSON)\nsettings.json · workers.json\nrecords.json · history.json\ndiffhist.json · proxy-stats.json\ntelegram.json · cubo-state.json")]
    end

    Miners <-->|"Stratum V1 TCP"| Proxy
    Proxy <-->|"Stratum V1 TCP"| Pools
    Proxy <-->|"Lê/Grava proxy-stats.json"| DataDir
    Painel -->|"HTTP GET 127.0.0.1:3336/stats\n(a cada 15s)"| Proxy
    Painel -->|"HTTPS GET"| ExtAPIs
    Painel <-->|"HTTPS Long Polling"| TgAPI
    Painel -->|"Executa stdin JSON -> stdout PNG"| Ticket
    Painel -->|"Envia R/P/S/T/0/1/2"| Arduino
    Painel <-->|"Lê/Grava estado JSON e settings.json"| DataDir
    EnvFile -.->|"Variáveis de ambiente"| Proxy
    EnvFile -.->|"Variáveis de ambiente"| Painel
    EnvFile -.->|"Variáveis de ambiente"| Cubo
    Cubo -->|"HTTP GET 127.0.0.1:3000/api/mining\n(a cada 60s)"| Painel
    Cubo -->|"HTTP POST JPEG"| CubeHW
    Cubo <-->|"Lê settings.json e cubo-state.json"| DataDir
    User <-->|"HTTP :3000"| Painel
```

### Inventário de Contêineres
| Contêiner | Runtime | Ponto de Entrada | Responsabilidade |
|---|---|---|---|
| **`mineracao-proxy`** | Node.js (>=16, sem deps) | [`src/proxy.js`](../../src/proxy.js) | Escuta nas portas `3333–3339`, repassa o tráfego Stratum V1 1:1, remonta o cabeçalho de 80 bytes para calcular dificuldade e hash de cada share, gerencia failover/failback de pools, persiste `proxy-stats.json` e expõe `http://127.0.0.1:3336/stats`. |
| **`mineracao-painel`** | Node.js (>=16, sem deps) | [`src/painel.js`](../../src/painel.js) | Serve a interface web bilíngue (`/`, `/config`) e APIs JSON (`/api/mining`, `/api/widget`, `/api/alarm`, `/api/config`), consulta o proxy local e APIs externas, aciona a sirene no Arduino e executa o bot do Telegram. |
| **`mineracao-cubo`** | Python 3 + Pillow | [`src/cubo.py`](../../src/cubo.py) | Consulta `/api/mining` a cada minuto, desenha o placar JPEG 240×240 a cada 5 minutos (ou a tela de comemoração por 10 minutos assim que sai novo recorde da fazenda) e faz o upload para o cubo GeekMagic. |
| **`ticket.py`** | Python 3 + Pillow | [`src/ticket.py`](../../src/ticket.py) | Chamado sob demanda pelo bot do Telegram (`src/telegram.js`) para renderizar o PNG 1080×1350 do bilhete de loteria do dia a partir do JSON de `/api/mining`. |
| **Armazenamento JSON (`DATA_DIR`)** | Sistema de arquivos | `/var/lib/mineracao` ou `/data` | Guarda `settings.json` (overlay da tela `/config`), `proxy-stats.json`, `workers.json`, `records.json`, `history.json`, `achievements.json`, `diffhist.json`, `telegram.json` e `cubo-state.json`. |

---

## Nível 3 — Componentes (C3)

### 3.1 Componentes do Proxy Stratum (`src/proxy.js` e `src/stratum.js`)

```mermaid
flowchart LR
    subgraph ProxyProcess["src/proxy.js"]
        Listeners["Listeners TCP por Rota\n(portas 3333–3339)"]
        Session["Máquina de Estados da Sessão\n(session / lineReader)"]
        StratumMath["Matemática do Cabeçalho Stratum\n(src/stratum.js)"]
        Health["Saúde e Failover de Pools\n(probe / healthCheck)"]
        StatsStore["Estatísticas e Histograma\n(workers, hist, saveStats)"]
        StatsHTTP["Servidor HTTP Local\n(127.0.0.1:3336/stats)"]
    end

    Listeners --> Session
    Session -->|"mining.submit + job + en1"| StratumMath
    Session <-->|"Escolhe pool / markDown"| Health
    Session -->|"Share aceito / recusado"| StatsStore
    StatsStore --> StatsHTTP
```

- **[`src/stratum.js`](../../src/stratum.js)**: Matemática criptográfica pura (`sha256d`, `swap32`, `shareDifficulty`, `hashDifficulty`) que remonta a transação coinbase, Merkle root, máscara de versão (`BIP310`) e o cabeçalho de 80 bytes do bloco para calcular a dificuldade exata atingida e o hash no formato dos exploradores.
- **Máquina de Estados da Sessão (`session` em [`src/proxy.js`](../../src/proxy.js))**: Enfileira as mensagens iniciais do minerador até a conexão com a pool abrir, acompanha `mining.subscribe` (`extranonce1`), `mining.configure` (`version-rolling.mask`), `mining.notify` (até 32 jobs ativos), `mining.set_difficulty` e correlaciona cada `mining.submit` com a resposta da pool.
- **Gerenciador de Saúde e Failover (`healthCheck`, `probe`)**: Marca pools que não respondem como fora do ar, direciona os mineradores para as pools reserva sem alterar o endereço de pagamento, testa as pools caídas a cada 60s e encerra as sessões na reserva quando a principal volta para forçar a reconexão na principal.

### 3.2 Componentes do Painel e Bot (`src/painel.js` e módulos)

```mermaid
flowchart TB
    subgraph PainelProcess["src/painel.js"]
        HTTPServer["Roteador e Servidor HTTP\n(/, /api/mining, /api/widget, /api/alarm)"]
        Collectors["Coletores em Segundo Plano\n(tickProxy, tickPool, tickCkpools,\ntickOcean, tickWallet, tickNetwork,\ntickDiffHist, tickLocal)"]
        StateEngine["Estado da Fazenda e Snapshot\n(workersView, snapshot, timeMachine, energy)"]
        LuckMod["Calculadora de Sorte\n(src/luck.js)"]
        I18nMod["Motor de Internacionalização\n(src/i18n.js)"]
        SettingsMod["Tela e Overlay de Configurações\n(src/settings.js)"]
        TelegramMod["Bot do Telegram e Diff de Alertas\n(src/telegram.js)"]
        MqttMod["Cliente MQTT 3.1.1 e HA Auto-Discovery\n(src/mqtt.js)"]
        TuyaMod["Cliente SmartLife / Tuya OpenAPI\n(src/tuya.js)"]
        AlarmMod["Controlador da Sirene USB\n(alarm / alarmStatus)"]
    end

    Collectors --> StateEngine
    Collectors --> TuyaMod
    StateEngine --> LuckMod
    StateEngine --> AlarmMod
    HTTPServer --> StateEngine
    HTTPServer --> I18nMod
    HTTPServer --> SettingsMod
    TelegramMod --> StateEngine
    TelegramMod --> TuyaMod
    MqttMod --> StateEngine
    MqttMod --> TelegramMod
```

- **[`src/painel.js`](../../src/painel.js)**: Orquestrador principal, loops de coleta (`every`), agregação de estado (`workersView`, `snapshot`), controle serial do Arduino (`alarm`) e SPA HTML/CSS/JS embutida.
- **[`src/luck.js`](../../src/luck.js)**: Modelo estatístico (`luckOf`, `theoreticalShare`), motor do campeonato semanal (`weekKey`, `weeklyStandings`) e motor de conquistas da fazenda (`ACHIEVEMENTS`, `evaluateAchievements`).
- **[`src/i18n.js`](../../src/i18n.js)**: Seleção de idioma (`?lang` > cookie `lang` > variável `LANGUAGE` > `Accept-Language` > `'en'`) e tradução determinística PT -> EN da página (`localizePage`).
- **[`src/settings.js`](../../src/settings.js)**: Renderiza `/config`, valida os campos (`clean`, incluindo mapas por worker de `WATTS` e `EXPECTED`, configurações MQTT e Tuya), verifica o `SETTINGS_PIN` em tempo constante via SHA-256 com bloqueio contra força bruta (`checkPin`), grava `settings.json`, exporta/restaura backups completos da fazenda (`exportBackup`, `restoreBackup`) e testa a comunicação com o Cubo, o Telegram, o broker MQTT e a tomada Tuya.
- **[`src/telegram.js`](../../src/telegram.js)**: Cliente de *long polling* (`getUpdates`), motor de detecção de eventos (`digest`, `diffEvents`), tratamento de comandos (`/status`, `/workers`, `/sorte`, `/recordes`, `/campeonato`, `/conquistas`, `/tomada`, `/bilhete`, `/ajuda`) e integração via subprocesso com `src/ticket.py`.
- **[`src/mqtt.js`](../../src/mqtt.js)**: Cliente MQTT 3.1.1 sem dependências sobre `net`/`tls` (`connectPacket`, `publishPacket`, `testBroker`, `start`), gerador de Home Assistant Auto-Discovery (`discoveryConfigs`), publicador de estado (`statePayload`) e publicador de eventos instantâneos reaproveitando `digest`/`diffEvents`.
- **[`src/tuya.js`](../../src/tuya.js)**: Cliente Tuya OpenAPI v1.0 sem dependências (`signRequest`, `parseStatus`, `createClient`, `testPlug`) para ler consumo real (Watts, Volts, mA, ligada/desligada) e ligar, desligar ou reiniciar uma tomada inteligente SmartLife.

---

## Nível 4 — Fluxos Dinâmicos (C4)

### 4.1 Envio de Share e Comemoração de Novo Recorde da Fazenda

```mermaid
sequenceDiagram
    autonumber
    participant M as ⛏️ Minerador
    participant P as ⚙️ Proxy (src/proxy.js)
    participant Pool as 🌐 Pool Stratum
    participant D as 🖥️ Painel (src/painel.js)
    participant S as 🚨 Sirene Arduino
    participant T as ✈️ Bot Telegram (src/telegram.js)
    participant C as 🧊 Daemon do Cubo (src/cubo.py)

    M->>P: mining.submit(worker, jobId, en2, ntime, nonce, vbits)
    P->>P: shareDifficulty() remonta cabeçalho de 80B e calcula diff/hash
    P->>Pool: Repassa mining.submit sem alteração
    Pool-->>P: {"id": ..., "result": true, "error": null}
    P->>P: Atualiza bestEver, dayBestHash, sorte e histograma
    P-->>M: Repassa {"result": true}
    D->>P: GET http://127.0.0.1:3336/stats (a cada 15s)
    P-->>D: JSON com estatísticas (workers, bestHash, dayBestHash, hist)
    D->>D: rememberWorkers() detecta best > topRecord() -> addRecord()
    D->>S: Escreve 'R' (ou 'r' no QUIET_HOURS) em /dev/ttyACM0
    T->>D: tick() compara digest(snapshot()) com o estado anterior
    T->>T: diffEvents() gera aviso 'record'
    T->>T: POST /bot<token>/sendMessage ("🏆 Novo recorde da fazenda!")
    C->>D: GET http://127.0.0.1:3000/api/mining (a cada 60s)
    C->>C: Detecta newest_farm_record() -> draw_party()
    C->>C: Envia JPEG 240×240 de festa para o Cubo por 10 min
```

### 4.2 Failover de Pool e Retorno Automático (Failback)

```mermaid
sequenceDiagram
    autonumber
    participant M as ⛏️ Minerador
    participant P as ⚙️ Proxy (src/proxy.js)
    participant Main as 🌐 Pool Principal
    participant Bkp as 🛡️ Pool Reserva

    M->>P: Conexão TCP + mining.subscribe / mining.authorize (na fila)
    P->>Main: Conexão TCP (timeout 8s)
    Main--xP: Timeout / ECONNREFUSED
    P->>P: markDown(Main)
    P->>Bkp: Conexão TCP na primeira reserva disponível
    Bkp-->>P: Conectado!
    P->>Bkp: Despeja fila (mining.subscribe e mining.authorize)
    Bkp-->>M: Mineração segue normalmente na Pool Reserva
    loop A cada 60s (HEALTH_MS)
        P->>Main: probe(Main)
        Main-->>P: Conexão TCP bem-sucedida!
        P->>P: markUp(Main)
        P->>M: Encerra sessão na reserva ("pool principal voltou")
    end
    M->>P: Reconecta automaticamente -> direcionado para a Pool Principal
```


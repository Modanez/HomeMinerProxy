# Changelog

## Unreleased

### English
- **Daily ticket on Telegram:** the 21:00 summary now comes with today's lottery-ticket image, and `/ticket` sends it any time. Rendered on the server by `ticket.py` (Pillow); without Pillow the summary stays text only.
- **Hide the wallet:** new "Show the wallet" option on the settings screen (`SHOW_WALLET=0`). Hides balance, value and activity from the dashboard and its API, for screens in view of visitors or dashboards opened from outside. The BTC price still shows and Telegram still alerts when money arrives.
- **Weekly championship & farm achievements:** weekly leaderboard ranked by relative luck (so slow ESP32/CPU miners can beat an ASIC) with a `🏆` badge on the leader, Sunday winner announcement in Telegram, `/championship` (`/campeonato`) and `/achievements` (`/conquistas`) commands, and 10 persistent farm achievements (`achievements.json`) with real-time Telegram alerts.
- **Home Assistant / MQTT integration:** zero-dependency MQTT 3.1.1 client (`src/mqtt.js`) with Home Assistant Auto-Discovery (11 sensors + 1 `pool_failover` binary sensor), `<prefix>/state`, `<prefix>/worker/<name>`, and real-time `<prefix>/event` triggers (`farm_record`, `worker_offline`, `achievement_unlocked`, etc.), configurable and testable from `/config`.
- **SmartLife / Tuya smart plug integration:** zero-dependency Tuya OpenAPI v1.0 client (`src/tuya.js`) that reads live Watts, Volts, current (mA), and switch state every 30s, supports monitor-only mode (e.g. a fan) or linking to a worker/farm (`TUYA_WORKER`), exposes `/plug` (`on`/`off`/`reboot`) on Telegram, and includes an optional watchdog (`TUYA_WATCHDOG_MIN`) to auto-reboot a frozen miner.
- **Settings screen — per-worker watts/hashrate & backup:** `/config` now edits `WATTS` and `EXPECTED` per worker (with immediate discovery when a miner connects to the proxy and a bar to pre-register worker name + watts + expected hashrate) and lets you download or restore a single-file JSON backup of settings, records, history, achievements and workers.
- **Architecture & API docs:** C4 Model diagrams (`docs/c4`), Architecture Decision Records (`docs/adr`) and Postman v2.1 collections + environment (`docs/postman`), all in English and Brazilian Portuguese.

### Português
- **Bilhete do dia no Telegram:** o resumo das 21h agora vem com a imagem do bilhete de loteria do dia, e o `/bilhete` manda a qualquer hora. Gerado no servidor pelo `ticket.py` (Pillow); sem Pillow, o resumo continua só em texto.
- **Esconder a carteira:** nova opção "Mostrar a carteira" na tela de configurações (`SHOW_WALLET=0`). Tira saldo, valor e movimentação do painel e da API dele, para telas à vista de visitas ou painéis abertos de fora de casa. A cotação continua aparecendo, e o Telegram continua avisando quando entra dinheiro.
- **Campeonato semanal e conquistas da fazenda:** ranking da semana ordenado por sorte relativa (permitindo que o vovô devkit/ESP32 vença um ASIC), troféu `🏆` no líder, anúncio do campeão no resumo de domingo, comandos `/campeonato` e `/conquistas` no Telegram e 10 conquistas persistentes (`achievements.json`) com aviso em tempo real no bot.
- **Integração Home Assistant / MQTT:** cliente MQTT 3.1.1 sem dependências (`src/mqtt.js`) com Home Assistant Auto-Discovery (11 sensores + 1 sensor binário `pool_failover`), `<prefixo>/state`, `<prefixo>/worker/<nome>` e gatilhos em tempo real em `<prefixo>/event` (`farm_record`, `worker_offline`, `achievement_unlocked`, etc.), configurável e testável pela tela `/config`.
- **Integração com Tomada Inteligente SmartLife / Tuya:** cliente Tuya OpenAPI v1.0 sem dependências (`src/tuya.js`) que lê Watts, Volts, corrente (mA) e estado ligada/desligada a cada 30s, permite modo só monitorar (ex.: ventilador) ou vínculo com worker/fazenda (`TUYA_WORKER`), adiciona o comando `/tomada` (`ligar`/`desligar`/`reiniciar`) no Telegram e inclui watchdog opcional (`TUYA_WATCHDOG_MIN`) para reiniciar minerador travado.
- **Tela de configurações — watts/hashrate por worker e backup:** `/config` agora edita o `WATTS` e o `EXPECTED` de cada worker (com detecção imediata ao conectar no proxy e barra para cadastrar nome + watts + hashrate esperado de uma vez) e permite baixar ou restaurar um backup completo (configurações, recordes, histórico, conquistas e workers) num arquivo JSON único.
- **Documentação de arquitetura e APIs:** diagramas C4 Model (`docs/c4`), Registros de Decisão de Arquitetura (`docs/adr`) e coleções + ambiente Postman v2.1 (`docs/postman`), tudo em inglês e português.

## v0.2.0 — 2026-11-03

### English
- **Telegram bot:** alerts for farm records, stopped workers, pool failover and money arriving in the wallet (a found block gets its own message), a daily summary, and the commands /status, /workers, /luck, /records, /help. Silent during `QUIET_HOURS`. Long polling, so nothing on your network needs to be exposed.
- **Settings screen** (⚙️ on the dashboard, `/config`): bitcoin address, language, currency, kWh price, local miner, alarm exceptions, cube IP and the Telegram bot, with buttons to test the cube and send a Telegram test message. Saving requires `SETTINGS_PIN`. Values live in `settings.json`, on top of `/etc/mineracao.env`, and the dashboard and cube restart by themselves to apply them.
- **cpuminer guide** in the README: build and run on Linux, macOS, Android (Termux) and Windows, plus a systemd unit for running it next to the dashboard.
- The cube service is now always installed and waits until there is a `CUBE_IP` (set it in the `.env` or on the settings screen).

**Upgrading:** `cd HomeMinerProxy && git pull && sudo bash install.sh`. The installer creates the settings PIN and shows it at the end (it is also in `/etc/mineracao.env`). With Docker, set `SETTINGS_PIN` in `mineracao.env` and run `docker compose up -d --build`. Nothing in your existing configuration changes.

### Português
- **Bot do Telegram:** avisos de recorde da fazenda, worker parado, failover de pool e dinheiro entrando na carteira (bloco achado tem mensagem própria), resumo diário e os comandos /status, /workers, /sorte, /recordes, /ajuda. Sem som no `QUIET_HOURS`. Usa long polling, então nada da sua rede precisa ficar exposto.
- **Tela de configurações** (⚙️ no painel, `/config`): endereço de bitcoin, idioma, moeda, preço do kWh, minerador local, exceções do alarme, IP do cubo e o bot do Telegram, com botões para testar o cubo e mandar uma mensagem de teste no Telegram. Para salvar, pede o `SETTINGS_PIN`. Os valores ficam em `settings.json`, por cima do `/etc/mineracao.env`, e o painel e o cubo reiniciam sozinhos para aplicar.
- **Guia do cpuminer** no README: compilar e rodar no Linux, macOS, Android (Termux) e Windows, e um serviço systemd para rodar junto do painel.
- O serviço do cubo agora fica sempre instalado e espera até haver um `CUBE_IP` (no `.env` ou na tela de configurações).

**Para atualizar:** `cd HomeMinerProxy && git pull && sudo bash install.sh`. O instalador cria o PIN da tela de configurações e mostra no final (ele também fica em `/etc/mineracao.env`). No Docker, defina `SETTINGS_PIN` no `mineracao.env` e rode `docker compose up -d --build`. Nada da configuração atual muda.

## v0.1.0 — 2026-11-02

First public release / Primeira versão pública.

### English
- Zero-dependency Stratum V1 proxy: forwards miner ↔ pool traffic unchanged and computes the difficulty and hash of every share. The listening port picks the pool (public-pool, solo.ckpool US and EU, nerdminers, AtlasPool, OCEAN).
- Web dashboard with five screens (farm, Bitcoin network, history, "almost a block", luck), kiosk mode and a phone layout.
- Personal and farm records with confetti, Arduino siren, hall of fame and record history.
- Scoreboard for the GeekMagic SmallTV cube and a KWGT widget for Android.
- English and Brazilian Portuguese, with a PT | EN button; currency (USD/BRL) and power price per kWh are configurable.
- One-command installer with systemd; configuration in `/etc/mineracao.env`.
- **Pool failover:** each port can list backup pools. When the main pool is down, miners go to the backup; the main pool is retested every minute and miners move back when it recovers. The dashboard shows a warning while a backup is in use.
- **Luck screen:** each worker's best share vs. the statistically expected best for its work, and a histogram of share difficulties against the theoretical curve.
- **Daily ticket:** the 🎟️ button on "Almost a block" turns today's best hash into a shareable lottery-ticket image.
- Docker image with Docker Compose, and CI on GitHub Actions.
- Tests that check the share math against the real genesis block and block 1.

### Português
- Proxy Stratum V1 sem dependências: repassa o tráfego minerador ↔ pool sem alterar e calcula a dificuldade e o hash de cada share. A porta escolhe a pool (public-pool, solo.ckpool EUA e Europa, nerdminers, AtlasPool, OCEAN).
- Painel web com cinco telas (fazenda, rede Bitcoin, histórico, "quase bloco", sorte), modo kiosk e layout de celular.
- Recordes pessoais e da fazenda com confete, sirene no Arduino, hall da fama e histórico.
- Placar para o cubo GeekMagic SmallTV e widget KWGT para Android.
- Inglês e português do Brasil, com botão PT | EN; moeda (BRL/USD) e preço do kWh configuráveis.
- Instalador de um comando com systemd; configuração em `/etc/mineracao.env`.
- **Failover de pool:** cada porta pode ter pools reserva. Com a principal fora do ar, os mineradores vão para a reserva; a principal é testada a cada minuto e eles voltam quando ela se recupera. O painel mostra um aviso enquanto a reserva está em uso.
- **Tela Sorte:** o melhor share de cada worker contra o melhor esperado pela estatística, e um histograma das dificuldades dos shares contra a curva teórica.
- **Bilhete do dia:** o botão 🎟️ no "Quase bloco" transforma o melhor hash do dia numa imagem de bilhete de loteria para compartilhar.
- Imagem Docker com Docker Compose, e CI no GitHub Actions.
- Testes que conferem a matemática do share com o bloco gênese e o bloco 1 reais.

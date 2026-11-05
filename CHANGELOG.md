# Changelog

## Unreleased

### English
- **Ready-to-flash SD card images** for Raspberry Pi 3/4/5, Orange Pi Zero 3 and Odroid-C2, attached to every release: flash, plug the network cable, open `http://homeminer.local:3000`. Built from the official minimal images (SHA-256 checked), no address, PIN or credentials inside, SSH off on Armbian.
- **Optional local miner:** the images ship cpuminer, and the wizard (and ⚙️ Settings → Miners) asks whether the board should also mine, with how many cores and under which name. The dashboard manages its own `mineracao-minerador` service; a `minerd` service you created yourself is never touched.
- **Update button reports failures** (with the last log lines) instead of spinning.
- **First-setup wizard:** without `BTC_ADDRESS` the dashboard no longer refuses to start: it opens a 4-step wizard in the browser (language, bitcoin address, an admin PIN of your choice, currency and kWh price), saves it, restarts by itself and shows where to point each miner. If `/etc/mineracao.env` already has `SETTINGS_PIN`, the wizard asks for it. `SETUP_WIZARD=0` keeps the old behaviour. This is step 1 of ready-to-flash SD card images.
- **Update button:** ⚙️ Settings → 💾 Backup shows the installed version (and commit), the latest release on GitHub, and an **Update now** button (PIN) that runs `git pull && install.sh` through `systemd-run`. With Docker it shows the `docker compose` command instead.
- **Installer:** can run unattended (no address prompt → wizard; `HOMEMINER_IMAGE=1` skips the PIN so each device gets its own), writes `version.json`, never overwrites a PIN created in the wizard.

### Português
- **Imagens prontas para gravar no cartão SD** para Raspberry Pi 3/4/5, Orange Pi Zero 3 e Odroid-C2, anexadas a cada release: grave, ligue o cabo de rede e abra `http://homeminer.local:3000`. Montadas a partir das imagens mínimas oficiais (com SHA-256 conferido), sem endereço, PIN ou credenciais dentro, e com SSH desligado no Armbian.
- **Minerador local opcional:** as imagens vêm com o cpuminer, e o assistente (e ⚙️ Configurações → Mineradores) pergunta se a placa também vai minerar, com quantos núcleos e com qual nome. O painel controla o próprio serviço `mineracao-minerador`; um serviço `minerd` criado por você nunca é mexido.
- **O botão de atualizar mostra a falha** (com as últimas linhas do registro) em vez de ficar girando.
- **Assistente de primeira configuração:** sem `BTC_ADDRESS` o painel não se recusa mais a subir: abre um assistente de 4 passos no navegador (idioma, endereço de bitcoin, um PIN de administração escolhido pela pessoa, moeda e preço do kWh), grava, reinicia sozinho e mostra para onde apontar cada minerador. Se o `/etc/mineracao.env` já tem `SETTINGS_PIN`, o assistente pede esse PIN. `SETUP_WIZARD=0` mantém o comportamento antigo. É a etapa 1 das imagens prontas para gravar no cartão.
- **Botão de atualizar:** ⚙️ Configurações → 💾 Backup mostra a versão instalada (e o commit), a versão mais recente no GitHub e o botão **Atualizar agora** (com PIN), que roda `git pull && install.sh` pelo `systemd-run`. No Docker, mostra o comando do `docker compose`.
- **Instalador:** roda sem ninguém no teclado (sem endereço → assistente; `HOMEMINER_IMAGE=1` não cria PIN, para cada aparelho ter o seu), grava o `version.json` e nunca sobrescreve um PIN criado no assistente.

## Unreleased

### English
- **Ping per pool:** the farm screen and the Telegram `/status` show the ping of each pool in use (e.g. `public-pool 🟢 180 ms · nerdminers 🔴 706 ms`) instead of one average. Backup pools only probed by the failover no longer count, and `/stats` has `totals.pools` with label, ports, sessions, ping and grade. The overall `pingMs` is now averaged only over pools in use.

### Português
- **Ping por pool:** a tela da fazenda e o `/status` do Telegram mostram o ping de cada pool em uso (ex.: `public-pool 🟢 180 ms · nerdminers 🔴 706 ms`) em vez de uma média só. As pools reserva só testadas pelo failover não contam mais, e o `/stats` ganhou `totals.pools` com nome, portas, sessões, ping e nota. O `pingMs` geral agora é a média só das pools em uso.

## v0.3.0 — 2026-11-04

### English
- **Tuya plugs offline in the cloud:** the cloud keeps returning the last known readings and accepts commands for a plug that left the Wi-Fi. The dashboard now checks the `online` flag on every read and before every command, shows "offline in the Tuya cloud" instead of stale watts, stops counting them in the energy estimate and refuses on/off/reboot (dashboard and Telegram) with an explanation. New read-only diagnostic: `POST /api/plug` with `"action":"info"` (PIN protected) returns online state, category, raw status and the functions the device accepts.
- **Proxy diagnostics:** pool ping score (TCP connect and submit RTT, graded great/good/poor), a persisted event timeline (worker/pool up and down, failover, rejects), worker IP, share difficulty and extranonce1, global efficiency, proxy process uptime/RAM/CPU/write queue, 15 min / 1 h / 24 h hashrate averages (farm and per worker) and rejected shares split into stale and duplicate. All on `/stats` and the dashboard.
- **Sonoff plugs on the local network:** the plug list on `/config` now takes Sonoff plugs in LAN/DIY mode (by IP, no cloud or credentials) next to SmartLife/Tuya. They get the same dashboard buttons, Telegram `/plug on|off|reboot <worker>` and watchdog. The plug of the server itself (`LOCAL_WORKER`) can no longer be turned off or rebooted remotely, and a plug name the bot does not know is refused instead of falling back to the first plug.
- **Daily ticket on Telegram:** the 21:00 summary now comes with today's lottery-ticket image, and `/ticket` sends it any time. Rendered on the server by `ticket.py` (Pillow); without Pillow the summary stays text only.
- **Hide the wallet:** new "Show the wallet" option on the settings screen (`SHOW_WALLET=0`). Hides balance, value and activity from the dashboard and its API, for screens in view of visitors or dashboards opened from outside. The BTC price still shows and Telegram still alerts when money arrives.
- **Weekly championship & farm achievements:** weekly leaderboard ranked by relative luck (so slow ESP32/CPU miners can beat an ASIC) with a `🏆` badge on the leader, Sunday winner announcement in Telegram, `/championship` (`/campeonato`) and `/achievements` (`/conquistas`) commands, and 10 persistent farm achievements (`achievements.json`) with real-time Telegram alerts.
- **Home Assistant / MQTT integration:** zero-dependency MQTT 3.1.1 client (`src/mqtt.js`) with Home Assistant Auto-Discovery (11 sensors + 1 `pool_failover` binary sensor), `<prefix>/state`, `<prefix>/worker/<name>`, and real-time `<prefix>/event` triggers (`farm_record`, `worker_offline`, `achievement_unlocked`, etc.), configurable and testable from `/config`.
- **SmartLife / Tuya smart plug integration (dynamic multi-plug):** zero-dependency Tuya OpenAPI v1.0 client (`src/tuya.js`) with automatic probing across all 6 Tuya Data Centers (`us`, `us-east`, `eu`, `eu-west`, `cn`, `in`) that reads live Watts, Volts, current (mA), and switch state every 30s across any number of dynamic plugs (`TUYA_PLUGS`), supports monitor-only mode (e.g. a fan or smart lamp) or linking to a worker/farm, adds PIN-protected **Turn on / Turn off / Reboot** buttons on the dashboard Energy card (`POST /api/plug`), records 24h power telemetry (`w` in `history.json`) and farm efficiency (`J/TH`), exposes `/plug` (`on`/`off`/`reboot` by name or index) on Telegram, publishes `<prefix>/plug/<name>` on MQTT, and includes an optional per-plug watchdog to auto-reboot a frozen miner.
- **Settings screen — tabbed layout, 3 Material Design themes, per-worker watts/hashrate & backup:** `/config` is now organized into category tabs (`Farm`, `Miners`, `Telegram`, `Smart Plug`, `MQTT / HA`, `Cube`, `Backup`) with green status dots for configured integrations, automatic tab switching on validation errors, a sticky PIN bar, and a visual selector for **3 Material Design themes** (`obsidian`, `ocean`, `latte`) with instant live preview; edits `WATTS` and `EXPECTED` per worker (with immediate discovery when a miner connects to the proxy and a bar to pre-register worker name + watts + expected hashrate) and lets you download or restore a single-file JSON backup of settings, records, history, achievements and workers.
- **Architecture & API docs:** C4 Model diagrams (`docs/c4`), Architecture Decision Records (`docs/adr`) and Postman v2.1 collections + environment (`docs/postman`), all in English and Brazilian Portuguese.

### Português
- **Tomadas Tuya offline na nuvem:** a nuvem continua devolvendo a última leitura e aceita comandos para uma tomada que saiu do Wi-Fi. O painel agora confere o campo `online` a cada leitura e antes de cada comando, mostra "offline na nuvem Tuya" no lugar de watts velhos, deixa de contá-los na estimativa de energia e recusa ligar/desligar/reiniciar (painel e Telegram) com uma explicação. Novo diagnóstico só de leitura: `POST /api/plug` com `"action":"info"` (protegido por PIN) devolve o estado online, a categoria, o status bruto e as funções que o aparelho aceita.
- **Diagnóstico do proxy:** nota de ping da pool (conexão TCP e RTT do submit, classificado em ótimo/bom/ruim), linha do tempo de eventos gravada em disco (worker/pool no ar ou fora, failover, recusas), IP do worker, dificuldade e extranonce1, eficiência global, uptime/RAM/CPU/fila de escrita do processo do proxy, médias de hashrate de 15 min / 1 h / 24 h (fazenda e por worker) e shares recusados separados em stale e duplicado. Tudo no `/stats` e no painel.
- **Tomadas Sonoff pela rede local:** a lista de tomadas em `/config` agora aceita Sonoff no modo LAN/DIY (pelo IP, sem nuvem nem credenciais) junto com as SmartLife/Tuya. Elas ganham os mesmos botões no painel, o `/tomada ligar|desligar|reiniciar <worker>` no Telegram e o watchdog. A tomada do próprio servidor (`LOCAL_WORKER`) não pode mais ser desligada ou reiniciada de longe, e um nome de tomada que o bot não conhece é recusado em vez de cair na primeira tomada.
- **Bilhete do dia no Telegram:** o resumo das 21h agora vem com a imagem do bilhete de loteria do dia, e o `/bilhete` manda a qualquer hora. Gerado no servidor pelo `ticket.py` (Pillow); sem Pillow, o resumo continua só em texto.
- **Esconder a carteira:** nova opção "Mostrar a carteira" na tela de configurações (`SHOW_WALLET=0`). Tira saldo, valor e movimentação do painel e da API dele, para telas à vista de visitas ou painéis abertos de fora de casa. A cotação continua aparecendo, e o Telegram continua avisando quando entra dinheiro.
- **Campeonato semanal e conquistas da fazenda:** ranking da semana ordenado por sorte relativa (permitindo que o vovô devkit/ESP32 vença um ASIC), troféu `🏆` no líder, anúncio do campeão no resumo de domingo, comandos `/campeonato` e `/conquistas` no Telegram e 10 conquistas persistentes (`achievements.json`) com aviso em tempo real no bot.
- **Integração Home Assistant / MQTT:** cliente MQTT 3.1.1 sem dependências (`src/mqtt.js`) com Home Assistant Auto-Discovery (11 sensores + 1 sensor binário `pool_failover`), `<prefixo>/state`, `<prefixo>/worker/<nome>` e gatilhos em tempo real em `<prefixo>/event` (`farm_record`, `worker_offline`, `achievement_unlocked`, etc.), configurável e testável pela tela `/config`.
- **Integração com Tomadas Inteligentes SmartLife / Tuya (múltiplas tomadas dinâmicas):** cliente Tuya OpenAPI v1.0 sem dependências (`src/tuya.js`) com detecção automática entre os 6 Data Centers Tuya (`us`, `us-east`, `eu`, `eu-west`, `cn`, `in`) que lê Watts, Volts, corrente (mA) e estado ligada/desligada a cada 30s para qualquer quantidade de tomadas ou lâmpadas cadastradas (`TUYA_PLUGS`), permite modo só monitorar (ex.: ventilador ou lâmpada) ou vínculo por worker/fazenda, adiciona botões **Ligar / Desligar / Reiniciar** protegidos por PIN direto no card de Energia do painel (`POST /api/plug`), grava histórico de 24h de consumo (`w` em `history.json`) e eficiência da fazenda (`J/TH`), amplia o comando `/tomada` (`ligar`/`desligar`/`reiniciar` por nome ou número) no Telegram, publica `<prefixo>/plug/<nome>` no MQTT e inclui watchdog individual por tomada para reiniciar minerador travado.
- **Tela de configurações — layout em abas, 3 temas Material Design, watts/hashrate por worker e backup:** `/config` agora separa as categorias em abas (`Fazenda`, `Mineradores`, `Telegram`, `Tomada`, `MQTT / HA`, `Cubo`, `Backup`) com indicadores verdes para integrações ativas, foco automático na aba com erro de validação, barra inferior fixa de PIN e seletor visual com **3 temas Material Design** (`obsidian`, `ocean`, `latte`) com pré-visualização instantânea; edita o `WATTS` e o `EXPECTED` de cada worker (com detecção imediata ao conectar no proxy e barra para cadastrar nome + watts + hashrate esperado de uma vez) e permite baixar ou restaurar um backup completo (configurações, recordes, histórico, conquistas e workers) num arquivo JSON único.
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

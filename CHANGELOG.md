# Changelog

## Unreleased

### English
- **Telegram bot:** alerts for farm records, stopped workers, pool failover and money arriving in the wallet (a found block), a daily summary, and the commands /status, /workers, /luck, /records. Optional, configured with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- **Settings screen** (⚙️ on the dashboard, `/config`): address, language, currency, kWh price, local miner, alarm exceptions, cube IP and Telegram bot, protected by `SETTINGS_PIN`. Values live in `settings.json`, on top of the `.env`, and the dashboard and cube restart by themselves to apply them. The cube service is now always installed and waits until there is an IP.

### Português
- **Bot do Telegram:** avisos de recorde da fazenda, worker parado, failover de pool e dinheiro entrando na carteira (um bloco achado), resumo diário e os comandos /status, /workers, /sorte, /recordes. Opcional, configurado com `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`.
- **Tela de configurações** (⚙️ no painel, `/config`): endereço, idioma, moeda, preço do kWh, minerador local, exceções do alarme, IP do cubo e bot do Telegram, protegida pelo `SETTINGS_PIN`. Os valores ficam em `settings.json`, por cima do `.env`, e o painel e o cubo reiniciam sozinhos para aplicar. O serviço do cubo agora fica sempre instalado e espera até haver um IP.

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

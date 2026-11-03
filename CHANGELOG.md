# Changelog

## Unreleased

### English
- **Pool failover:** each port can list backup pools. When the main pool is down, miners go to the backup; the main pool is retested every minute and miners move back when it recovers. The dashboard shows a warning while a backup is in use.
- Docker image with Docker Compose, GitHub Actions CI, and new ports 3338 (AtlasPool) and 3339 (ckpool EU).
- **Luck screen:** each worker's best share vs. the statistically expected best for its work, and a histogram of share difficulties against the theoretical curve.
- **Daily ticket:** the 🎟️ button on "Almost a block" turns today's best hash into a shareable lottery-ticket image.

### Português
- **Failover de pool:** cada porta pode ter pools reserva. Com a principal fora do ar, os mineradores vão para a reserva; a principal é testada a cada minuto e eles voltam quando ela se recupera. O painel mostra um aviso enquanto a reserva está em uso.
- Imagem Docker com Docker Compose, CI no GitHub Actions e portas novas 3338 (AtlasPool) e 3339 (ckpool EU).
- **Tela Sorte:** o melhor share de cada worker contra o melhor esperado pela estatística, e um histograma das dificuldades dos shares contra a curva teórica.
- **Bilhete do dia:** o botão 🎟️ no "Quase bloco" transforma o melhor hash do dia numa imagem de bilhete de loteria para compartilhar.

## v0.1.0 — 2026-11-02

First public release / Primeira versão pública.

### English
- Zero-dependency Stratum V1 proxy: forwards miner ↔ pool traffic unchanged and computes the difficulty and hash of every share. The listening port picks the pool (public-pool, solo.ckpool, nerdminers, OCEAN).
- Web dashboard with four screens (farm, Bitcoin network, history, "almost a block"), kiosk mode and a phone layout.
- Personal and farm records with confetti, Arduino siren, hall of fame and record history.
- Scoreboard for the GeekMagic SmallTV cube and a KWGT widget for Android.
- English and Brazilian Portuguese, with a PT | EN button; currency (USD/BRL) and power price per kWh are configurable.
- One-command installer with systemd; configuration in `/etc/mineracao.env`.
- Tests that check the share math against the real genesis block and block 1.

### Português
- Proxy Stratum V1 sem dependências: repassa o tráfego minerador ↔ pool sem alterar e calcula a dificuldade e o hash de cada share. A porta escolhe a pool (public-pool, solo.ckpool, nerdminers, OCEAN).
- Painel web com quatro telas (fazenda, rede Bitcoin, histórico, "quase bloco"), modo kiosk e layout de celular.
- Recordes pessoais e da fazenda com confete, sirene no Arduino, hall da fama e histórico.
- Placar para o cubo GeekMagic SmallTV e widget KWGT para Android.
- Inglês e português do Brasil, com botão PT | EN; moeda (BRL/USD) e preço do kWh configuráveis.
- Instalador de um comando com systemd; configuração em `/etc/mineracao.env`.
- Testes que conferem a matemática do share com o bloco gênese e o bloco 1 reais.

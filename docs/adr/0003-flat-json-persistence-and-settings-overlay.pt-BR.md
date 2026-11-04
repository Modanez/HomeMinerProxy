# ADR-0003: Persistência em Arquivos JSON e Overlay `settings.json` Protegido por PIN

[English](0003-flat-json-persistence-and-settings-overlay.md) · **Português**

- **Status:** Aceita
- **Data:** 2026-11-03

## Contexto

O **HomeMinerProxy** precisa persistir:
1. Telemetria e histórico: workers conhecidos (`workers.json`), hall da fama (`records.json`), histórico de 48h de hashrate (`history.json`), histórico de dificuldade da rede (`diffhist.json`), estatísticas do proxy (`proxy-stats.json`), offset do Telegram (`telegram.json`) e estado do cubo (`cubo-state.json`).
2. Configuração do usuário: a configuração base fica em `/etc/mineracao.env` (pertencente ao `root`, lida pelo `systemd` ou Docker Compose), enquanto o painel roda com usuário sem privilégios (`mineracao` ou `node`) e oferece a tela web `/config`.

## Decisão

1. **Arquivos JSON Simples em `DATA_DIR`**: Em vez de um banco de dados embutido (SQLite, LevelDB), os dados ficam em arquivos JSON pequenos e legíveis dentro de `DATA_DIR` (`/var/lib/mineracao` no systemd, volume `/data` no Docker).
2. **Overlay de Configuração (`DATA_DIR/settings.json`)**:
   - A configuração base permanece em `/etc/mineracao.env`.
   - Quando o usuário salva alterações em `/config`, o `src/settings.js` grava apenas os campos alterados em `DATA_DIR/settings.json` (de forma atômica via `.tmp` + `fs.renameSync` com permissão `0600`).
   - Ao iniciar, tanto o `src/painel.js` (`settings.applyOverlay`) quanto o `src/cubo.py` aplicam os valores de `settings.json` por cima das variáveis de ambiente vindas do `.env`.
3. **Proteção por PIN e Bloqueio contra Força Bruta**:
   - Salvar, testar ou exportar/restaurar backups na tela `/config` exige o `SETTINGS_PIN`, verificado em tempo constante via `crypto.timingSafeEqual` sobre hashes SHA-256 (`checkPin`).
   - Após 5 tentativas erradas em 15 minutos, novas tentativas são bloqueadas (`HTTP 429`).
   - Segredos (`TELEGRAM_BOT_TOKEN`, `MQTT_PASS`, `TUYA_SECRET`) nunca voltam em texto aberto no `GET /api/config` (apenas `{ set: true, tail: "4últimos" }`).
   - A interface `/config` organiza as categorias em abas (`Fazenda`, `Mineradores`, `Telegram`, `Tomada`, `MQTT / HA`, `Cubo`, `Backup`) com indicadores luminosos de seção ativa/configurada, mudança automática para a aba com erro de validação e barra inferior fixa de `PIN` + salvar.
4. **Backup e Restauração em Arquivo Único (`/api/config/backup` e `/api/config/restore`)**:
   - `exportBackup` reúne `settings.json`, `workers.json`, `records.json`, `history.json`, `proxy-stats.json`, `telegram.json` e `cubo-state.json` num único JSON versionado (`version: 1`).
   - `restoreBackup` valida cada seção contra um esquema estrito e grava apenas numa lista fechada de arquivos permitidos (`BACKUP_FILES`) de forma atômica (`.tmp` + `fs.renameSync`), reiniciando o painel em seguida para recarregar o estado restaurado.

## Consequências

- **Positivas:**
  - O serviço do painel não precisa de permissão de `root` nem de escrita em `/etc/mineracao.env`.
  - Fazer backup ou migrar de servidor consiste apenas em copiar a pasta `DATA_DIR`.
  - Gravação atômica via arquivo temporário evita corrupção do `settings.json`.
- **Negativas / Trade-offs:**
  - Opções exclusivas do proxy (como `PROXY_ROUTES`) continuam sendo editadas em `/etc/mineracao.env`.


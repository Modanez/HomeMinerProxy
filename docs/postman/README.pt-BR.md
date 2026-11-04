# 📮 Coleções Postman — APIs HTTP do HomeMinerProxy

[English](README.md) · **Português**

Este diretório contém as **coleções Postman v2.1** e o arquivo de ambiente cobrindo todos os endpoints HTTP expostos pelo **Painel (`src/painel.js`)** e pelo **Proxy Stratum (`src/proxy.js`)**.

## Arquivos

| Arquivo | Descrição |
|---|---|
| [`HomeMinerProxy.pt-BR.postman_collection.json`](HomeMinerProxy.pt-BR.postman_collection.json) | Coleção Postman v2.1 em **Português (pt-BR)** |
| [`HomeMinerProxy.postman_collection.json`](HomeMinerProxy.postman_collection.json) | Coleção Postman v2.1 em **Inglês (en)** |
| [`HomeMinerProxy.postman_environment.json`](HomeMinerProxy.postman_environment.json) | Ambiente Postman com as variáveis locais padrão |

## Como importar no Postman

1. Abra o **Postman** -> **Import**.
2. Selecione [`HomeMinerProxy.pt-BR.postman_collection.json`](HomeMinerProxy.pt-BR.postman_collection.json) (ou [`HomeMinerProxy.postman_collection.json`](HomeMinerProxy.postman_collection.json)) e [`HomeMinerProxy.postman_environment.json`](HomeMinerProxy.postman_environment.json).
3. Ative o ambiente **HomeMinerProxy Local** no canto superior direito e ajuste `baseUrl` ou `settingsPin` conforme necessário.

## Endpoints Cobertos

### 1. Páginas do Painel (`:3000`)
- `GET /` — Página HTML principal do painel (segue `LANGUAGE` ou o idioma do navegador).
- `GET /?lang=pt` e `GET /?lang=en` — Força o idioma para português ou inglês.
- `GET /?kiosk` — Modo kiosk (alterna as 5 telas automaticamente e esconde o cursor).
- `GET /config` — Página HTML da tela de configurações.

### 2. APIs de Dados e Periféricos do Painel (`:3000`)
- `GET /api/mining` — Snapshot completo da fazenda (`farm`, `hall`, `recentRecords`, `history`, `energy`, `wallet`, `net`, `nearBlock`, `luck`, `proxy`, `ocean`, `ckpools`, `health`).
- `GET /api/widget?lang=pt` e `GET /api/widget?lang=en` — Resumo enxuto e já formatado para widgets de celular (KWGT).
- `GET /api/alarm?e=T` — Envia um comando manual para a sirene Arduino na USB (`T` teste, `R` recorde da fazenda, `P` recorde pessoal, `S` share, `0` verde, `1` amarelo, `2` vermelho).
- `POST /api/plug` — Controla uma tomada inteligente SmartLife / Tuya cadastrada em `TUYA_PLUGS` (`action: "on" | "off" | "reboot"`, `id` opcional da tomada; exige `pin`).

### 3. APIs de Configuração e Backup (`:3000`)
- `GET /api/config` — Retorna os valores atuais (incluindo os mapas `WATTS` e `EXPECTED` por worker e mascarando o `TELEGRAM_BOT_TOKEN` com apenas os 4 últimos caracteres), a lista de workers conhecidos e se há `SETTINGS_PIN` definido.
- `POST /api/config` — Valida e grava as alterações em `DATA_DIR/settings.json` (exige `pin`) e reinicia o painel quando houver mudança.
- `POST /api/config/test` (`what: "cube"`) — Testa se o cubo GeekMagic SmallTV responde em `CUBE_IP`.
- `POST /api/config/test` (`what: "telegram"`) — Envia uma mensagem de teste no Telegram usando o token informado (ou já salvo) e `TELEGRAM_CHAT_ID`.
- `POST /api/config/test` (`what: "mqtt"`) — Testa a conexão TCP/TLS e a autenticação com o broker MQTT 3.1.1 (`MQTT_URL`, `MQTT_USER`, `MQTT_PASS`, `MQTT_TOPIC`).
- `POST /api/config/test` (`what: "tuya"`) — Testa a autenticação HMAC-SHA256 e lê os Watts/Volts reais da tomada inteligente SmartLife / Tuya (`TUYA_REGION`, `TUYA_CLIENT_ID`, `TUYA_SECRET`, `TUYA_DEVICE_ID`).
- `POST /api/config/backup` — Exporta um backup completo em JSON (`version: 1`) com `settings`, `workers`, `records`, `history`, `achievements`, `proxyStats`, `telegram` e `cubo` (exige `pin`).
- `POST /api/config/restore` — Valida e restaura um arquivo de backup em `DATA_DIR` (exige `pin`) e reinicia o painel.

### 4. API Interna do Proxy Stratum (`127.0.0.1:3336`)
- `GET /stats` — Estatísticas brutas em tempo real por worker, saúde e failover das rotas/pools, shares da última hora, `bestHash`, `dayBestHash` e o histograma de 40 faixas de dificuldade (`hist`).


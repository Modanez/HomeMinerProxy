# ADR-0008: Integração Direta com Tomada Inteligente SmartLife / Tuya OpenAPI v1.0

[English](0008-smartlife-tuya-smart-plug.md) · **Português**

- **Status:** Aceita
- **Data:** 2026-11-04

## Contexto

Mineradores solo caseiros costumam ligar seus ASICs (como o Bitaxe) ou ventiladores de refrigeração em **tomadas inteligentes Wi-Fi SmartLife / Tuya** com medidor de consumo. Os usuários precisam de:
1. **Telemetria de energia em tempo real** (Watts, Volts, mA e estado ligada/desligada) direto no painel, no Telegram e no MQTT, sem depender obrigatoriamente de um servidor Home Assistant separado.
2. **Vínculo flexível (`TUYA_WORKER`)**:
   - **Modo só monitorar (`""`)**: exibe os Watts e Volts reais da tomada no painel (por exemplo, monitorando um ventilador enquanto o Bitaxe não chega) sem somar esse consumo na estimativa de conta de luz dos mineradores.
   - **Worker específico (`bitaxe`) ou fazenda inteira (`*`)**: substitui a estimativa fixa de `WATTS` pela leitura real da tomada inteligente.
3. **Controle remoto e watchdog de reinício automático**: possibilidade de ligar, desligar ou reiniciar a tomada pelo Telegram (`/tomada ligar|desligar|reiniciar`) e, opcionalmente, reiniciar automaticamente o minerador travado se ele ficar `TUYA_WATCHDOG_MIN` minutos sem enviar shares.

## Decisão

Implementamos um cliente nativo **Tuya OpenAPI v1.0** sem dependências externas em [`src/tuya.js`](../../src/tuya.js) usando apenas os módulos nativos `https` e `crypto` do Node.js:

1. **Assinatura HMAC-SHA256 (`signRequest`) e Descoberta Automática entre os 6 Data Centers**:
   - Implementa a assinatura oficial da Tuya OpenAPI v1.0 (`client_id + access_token + t + nonce + stringToSign`) com cache de token e renovação transparente quando o token expira (`code: 1010`).
   - Suporta todos os 6 Data Centers regionais da Tuya (`us`, `us-east`, `eu`, `eu-west`, `cn`, `in`) e testa automaticamente os demais endpoints caso a região escolhida retorne `sign invalid` (`1004`), `permission deny` (`1106`) ou `"data center is suspended"` (comum no plano Trial gratuito da Tuya, que permite apenas `1 / 1` Data Center ativo).
2. **Normalização dos DPs de Energia (`parseStatus`) e Fallback de Rotas**:
   - Consulta `/v1.0/iot-03/devices/{id}/status` com fallback automático para `/v1.0/devices/{id}/status`, `/v1.0/devices/{id}` e `/v2.0/cloud/thing/{id}/shadow/properties`.
   - Converte tanto os nomes padrão de tomadas Tuya (`switch_1`, `cur_power` em `0,1 W`, `cur_voltage` em `0,1 V`, `cur_current` em `mA`, `add_ele` em `0,001 kWh`) quanto os códigos numéricos legados (`1`, `19`, `20`, `18`, `17`).
3. **Lista Dinâmica de Múltiplas Tomadas (`TUYA_PLUGS`) e Migração Automática**:
   - Permite cadastrar quantas tomadas ou dispositivos SmartLife / Tuya o usuário quiser (`TUYA_PLUGS` como array JSON de `{ name, deviceId, worker, watchdogMin }`) usando o mesmo projeto e o mesmo token OAuth em cache.
   - `normalizePlugs()` migra automaticamente a configuração legada de tomada única (`TUYA_DEVICE_ID`, `TUYA_WORKER`, `TUYA_WATCHDOG_MIN`) para a lista dinâmica sem perder nada.
4. **Mascaramento de Segredo em `/config` e Controle Direto pelo Painel (`POST /api/plug`)**:
   - `TUYA_SECRET` é tratado como campo secreto em [`src/settings.js`](../../src/settings.js) (mascarado para os 4 últimos caracteres em `GET /api/config` e salvo com permissão `0600` em `settings.json`).
   - `POST /api/plug` permite ligar, desligar ou reiniciar qualquer tomada cadastrada direto pelo card de Energia do painel principal, exigindo validação timing-safe do `SETTINGS_PIN` com bloqueio contra força bruta.
5. **Cooldown do Watchdog e Histórico de Consumo 24h**:
   - Quando `watchdogMin >= 5` e há um `worker` vinculado à tomada, [`src/painel.js`](../../src/painel.js) faz o *power-cycle* daquela tomada (desliga por 8 s e religa) se o minerador ficar `stale` acima do limite, respeitando um intervalo mínimo de 60 minutos entre reinícios automáticos e avisando no Telegram/MQTT (`plug_reboot`).
   - `sampleHistory()` registra os Watts (`w`) junto com o hashrate (`hr`) em `history.json`.

## Consequências

- **Positivas:** Funciona direto com qualquer tomada SmartLife / Tuya com medidor de energia usando uma conta gratuita na Tuya IoT Platform, sem nenhuma dependência npm, com botão "Testar tomada" em `/config` e transição imediata entre apenas monitorar um ventilador hoje ou medir/reiniciar o Bitaxe quando ele chegar.
- **Negativas / Trade-offs:** Depende da Tuya Cloud OpenAPI (exige acesso HTTPS de saída para `openapi.tuyaus.com` / `tuyaeu.com`, o que o painel já utiliza para consultar a rede Bitcoin e a cotação).


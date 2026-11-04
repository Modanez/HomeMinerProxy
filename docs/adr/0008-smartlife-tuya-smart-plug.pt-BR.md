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

1. **Assinatura HMAC-SHA256 (`signRequest`)**:
   - Implementa a assinatura oficial da Tuya OpenAPI v1.0 (`client_id + access_token + t + nonce + stringToSign`) com cache de token e renovação transparente quando o token expira (`code: 1010`).
2. **Normalização dos DPs de Energia (`parseStatus`)**:
   - Converte tanto os nomes padrão de tomadas Tuya (`switch_1`, `cur_power` em `0,1 W`, `cur_voltage` em `0,1 V`, `cur_current` em `mA`, `add_ele` em `0,001 kWh`) quanto os códigos numéricos legados (`1`, `19`, `20`, `18`, `17`).
3. **Mascaramento de Segredo em `/config`**:
   - `TUYA_SECRET` é tratado como campo secreto em [`src/settings.js`](../../src/settings.js) (mascarado para os 4 últimos caracteres em `GET /api/config` e salvo com permissão `0600` em `settings.json`).
4. **Cooldown do Watchdog**:
   - Quando `TUYA_WATCHDOG_MIN >= 5` e há um `TUYA_WORKER` vinculado, [`src/painel.js`](../../src/painel.js) faz o *power-cycle* da tomada (desliga por 8 s e religa) se o minerador ficar `stale` acima do limite, respeitando um intervalo mínimo de 60 minutos entre reinícios automáticos e avisando no Telegram/MQTT (`plug_reboot`).

## Consequências

- **Positivas:** Funciona direto com qualquer tomada SmartLife / Tuya com medidor de energia usando uma conta gratuita na Tuya IoT Platform, sem nenhuma dependência npm, com botão "Testar tomada" em `/config` e transição imediata entre apenas monitorar um ventilador hoje ou medir/reiniciar o Bitaxe quando ele chegar.
- **Negativas / Trade-offs:** Depende da Tuya Cloud OpenAPI (exige acesso HTTPS de saída para `openapi.tuyaus.com` / `tuyaeu.com`, o que o painel já utiliza para consultar a rede Bitcoin e a cotação).


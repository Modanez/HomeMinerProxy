# ADR-0001: Zero Dependências npm de Terceiros nos Serviços Node.js

[English](0001-zero-dependency-nodejs.md) · **Português**

- **Status:** Aceita
- **Data:** 2026-11-02

## Contexto

O **HomeMinerProxy** foi projetado para rodar 24/7 em computadores pequenos e de baixo consumo na rede doméstica (Odroid-C2, Raspberry Pi, Orange Pi, notebooks antigos), com pouca memória RAM, armazenamento SD/eMMC lento e diferentes arquiteturas (`armv7`, `aarch64`, `x86_64`).

Depender de pacotes externos do `npm` traz:
1. Riscos de segurança na cadeia de suprimentos (*supply chain*) — ponto sensível em qualquer software ligado a Bitcoin, mesmo lidando apenas com endereços públicos.
2. Atrito na instalação (`npm install`, compilação de módulos nativos, quebra de dependências com o tempo) em placas ARM.
3. Consumo desnecessário de disco e memória.

## Decisão

Todos os módulos em Node.js (`src/proxy.js`, `src/painel.js`, `src/stratum.js`, `src/luck.js`, `src/i18n.js`, `src/settings.js`, `src/telegram.js`) e seus testes (`tests/*.test.js`) utilizam **exclusivamente módulos nativos do Node.js** (`net`, `http`, `https`, `crypto`, `fs`, `path`, `os`, `child_process`, `node:test`, `node:assert`).

O `package.json` não possui nenhuma entrada em `"dependencies"` nem em `"devDependencies"`.

## Consequências

- **Positivas:**
  - Instalação instantânea (o `install.sh` apenas copia `src/*.js` e `src/*.py` para `/opt/mineracao`, sem precisar rodar `npm install`).
  - Risco zero de vulnerabilidades vindas de pacotes de terceiros no npm.
  - Uso mínimo de memória (~30–45 MB por processo) e inicialização imediata.
- **Negativas / Trade-offs:**
  - Uploads `multipart/form-data` (como no `sendPhoto` do Telegram), novas tentativas HTTP e leitura linha a linha do protocolo Stratum JSON-RPC são implementados diretamente no código do projeto.


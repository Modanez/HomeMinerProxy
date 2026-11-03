# ADR-0005: Python + Pillow para o Placar do Cubo GeekMagic e o Bilhete de Loteria no Telegram

[English](0005-python-pillow-for-cube-and-lottery-ticket.md) · **Português**

- **Status:** Aceita
- **Data:** 2026-11-03

## Contexto

Duas funcionalidades opcionais precisam gerar imagens rasterizadas (JPEG / PNG) no servidor:
1. **Cubo GeekMagic SmallTV (`src/cubo.py`)**: Precisa de uma imagem JPEG 240×240 enviada via HTTP (`/doUpload`) a cada 5 minutos e quando sai um novo recorde da fazenda.
2. **Bilhete de Loteria Diário no Telegram (`src/ticket.py`)**: Precisa de uma imagem PNG 1080×1350 anexada ao resumo diário das 21h e ao comando `/bilhete` (equivalente ao bilhete desenhado em `<canvas>` no navegador).

No Node.js, gerar imagens no servidor (`canvas`, `sharp`, `@napi-rs/canvas`) exige binários nativos C++ pesados que violam a [ADR-0001](0001-zero-dependency-nodejs.pt-BR.md) e frequentemente falham em placas ARM. Por outro lado, Python 3 com `python3-pil` (`Pillow`) e `fonts-dejavu-core` já vêm empacotados nativamente em qualquer Debian/Ubuntu/Armbian/Alpine.

## Decisão

1. Usar **Python 3 com Pillow (`PIL`)** para renderização de imagens no servidor em dois scripts independentes:
   - [`src/cubo.py`](../../src/cubo.py): Serviço que consulta `http://127.0.0.1:3000/api/mining` e envia JPEGs 240×240 para o cubo.
   - [`src/ticket.py`](../../src/ticket.py): Utilitário CLI que lê o JSON de `/api/mining` pela entrada padrão (`stdin`) e escreve o PNG 1080×1350 na saída padrão (`stdout`), chamado sob demanda por `ticketImage()` em [`src/telegram.js`](../../src/telegram.js).
2. **Degradação Elegante**:
   - Se o Python 3 ou o Pillow não estiverem instalados, o `src/proxy.js` e o `src/painel.js` continuam funcionando normalmente; o bot do Telegram envia o resumo diário apenas em texto e o `src/cubo.py` aguarda em espera sem derrubar o serviço do `systemd`.

## Consequências

- **Positivas:**
  - Mantém os serviços Node.js 100% livres de dependências externas e permite desenhar fontes DejaVu nítidas e carimbos rotacionados (`PREMIADO!` / `NÃO PREMIADO`) em qualquer placa Linux ou contêiner Docker.
  - Ambos os scripts podem ser testados e executados diretamente pelo terminal (`--json` / `--out`).
- **Negativas / Trade-offs:**
  - Adiciona Python 3 ao repositório especificamente para a geração de imagens.


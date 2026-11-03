# ADR-0004: Código-Fonte HTML em Português com Tabela Determinística de Tradução (`src/i18n.js`)

[English](0004-bilingual-pt-source-with-i18n-table.md) · **Português**

- **Status:** Aceita
- **Data:** 2026-11-02

## Contexto

O painel (`src/painel.js`) é um servidor em arquivo único com HTML, CSS e JavaScript embutidos. Ele precisa funcionar tanto em **português do Brasil (`pt-BR`)** quanto em **inglês (`en`)** em todas as telas, formatações numéricas, moedas (`BRL` / `USD`) e textos explicativos, sem adicionar bibliotecas de internacionalização no navegador nem duplicar o template HTML inteiro.

## Decisão

1. **Template Base em Português (`PAGE` em `src/painel.js`)**: O template principal HTML/JS em `src/painel.js` é escrito diretamente em português.
2. **Tabela Determinística de Tradução (`src/i18n.js`)**:
   - A tabela `EN_PAIRS` mapeia cada trecho em português para o equivalente em inglês, ordenada do maior para o menor trecho para evitar substituições parciais.
   - A função `localizePage(html, lang, currency)` gera e guarda em cache o HTML traduzido por idioma (`pageCache[lang]`), injetando também `LOC` (`pt-BR` ou `en-US`) e `CUR` (`BRL` ou `USD`).
3. **Verificação Automatizada em Testes (`tests/i18n.test.js`)**:
   - Garante que todo trecho da tabela `EN_PAIRS` existe em `src/painel.js` (avisa imediatamente se um texto da página mudar sem atualizar a tradução).
   - Compila o `<script>` resultante nos dois idiomas (`new vm.Script()`) para garantir que nenhuma substituição quebre a sintaxe JavaScript.
   - Verifica se a página em inglês não deixou escapar palavras ou acentos do português.

## Consequências

- **Positivas:**
  - Uma única fonte de verdade para o HTML/JS em `src/painel.js`, com custo zero de tradução no navegador (a página é traduzida uma única vez e servida do cache em memória).
  - Qualquer divergência entre o texto em português e a tradução em inglês falha imediatamente no `npm test`.
- **Negativas / Trade-offs:**
  - Sempre que um texto em português de `src/painel.js` for alterado, é necessário atualizar o par correspondente em `src/i18n.js`.


# ADR-0006: Campeonato Semanal por Sorte Relativa e Conquistas Persistentes da Fazenda

[English](0006-weekly-championship-and-achievements.md) · **Português**

- **Status:** Aceita
- **Data:** 2026-11-03

## Contexto
Uma fazenda de mineração solo caseira costuma misturar mineradores com até 7 ordens de grandeza de diferença no hashrate — de um ESP32/devkit a ~350 kH/s ou uma CPU de Odroid a ~2,7 MH/s até um ASIC Bitaxe a ~1,2 TH/s.
1. Se um campeonato semanal ordenasse os workers apenas pela dificuldade bruta do melhor share, o ASIC venceria quase todas as semanas, sem chance real de troféu para os mineradores pequenos ("vovôs").
2. Além disso, como achar um bloco real de Bitcoin em casa leva milhares de anos em média, marcos intermediários (conquistas) ajudam a celebrar a evolução da fazenda no painel e no Telegram.

## Decisão
1. **Campeonato Semanal por Sorte Relativa (`weeklyStandings` em [`src/luck.js`](../../src/luck.js))**:
   - O [`src/proxy.js`](../../src/proxy.js) acumula contadores semanais por worker (`shares`, `work`, `best`, `bestAt`) identificados pela segunda-feira da semana (`weekKey(ms)`), arquivando a semana encerrada em `lastWeek` na virada de segunda-feira.
   - `weeklyStandings(weekObj, records)` ordena os workers primeiro pelo **fator de sorte da semana** ($\text{melhor} / (W / \ln 2)$), desempatando pelo maior share bruto quando não há trabalho medido pelo proxy. Como a sorte relativa normaliza pelo trabalho realizado, um ESP32/devkit de 350 kH/s disputa o troféu de igual para igual com um Bitaxe de 1,2 TH/s.
   - O líder da semana recebe o troféu `🏆` na Tela 1 ("Fazenda"), um card completo de pódio na Tela 5 ("Sorte"), o comando `/campeonato` (`/championship`) no Telegram e o anúncio do campeão no resumo de domingo.
2. **Conquistas Persistentes da Fazenda (`ACHIEVEMENTS`, `evaluateAchievements` em [`src/luck.js`](../../src/luck.js))**:
   - Definimos 10 marcos bilíngues (`first_share`, `diff_1k`, `diff_1m`, `diff_1b`, `shares_1k`, `shares_100k`, `luck_2x`, `luck_10x`, `week_nonstop` e `underdog` / "Troféu vovô").
   - As conquistas desbloqueadas são salvas em `DATA_DIR/achievements.json` (incluído no backup/restauração de arquivo único em `/config`), exibidas na Tela 5 ("Sorte"), consultáveis por `/conquistas` (`/achievements`) no Telegram e notificadas em tempo real pelo bot.

## Consequências
- **Positivas:** Qualquer minerador da fazenda — independentemente do hashrate — pode ganhar o troféu da semana, e as conquistas tornam a mineração solo divertida no dia a dia.
- **Negativas:** Acrescenta um pequeno arquivo JSON (`achievements.json`) ao `DATA_DIR` e dois campos (`week`, `lastWeek`) ao `proxy-stats.json`.

# ⛏️ Fazenda de Mineração (HomeMinerProxy)

[English](README.md) · **Português**

Proxy Stratum e painel para **mineração solo caseira**: Bitaxe, NerdMiner, ESP32, cpuminer no notebook ou no celular. Tudo roda num computador pequeno da casa (Odroid, Raspberry Pi, Orange Pi ou qualquer Linux), **sem dependências** além do Node.js.

A ideia é transformar a "loteria do bloco" em algo divertido de acompanhar: cada share aparece na hora, os recordes disparam confete e sirene, e uma tela mostra o abismo entre o nosso melhor hash e o hash do último bloco da rede.

## Como funciona

```
Bitaxe / NerdMiner / cpuminer ──► proxy (porta 3333, 3334, 3335…) ──► pool
                                    │
                                    └─► calcula a dificuldade de cada share ──► painel web, sirene, cubo
```

- **Proxy Stratum** (`src/proxy.js`): cada minerador se conecta no servidor da casa em vez da pool. O proxy repassa tudo **sem alterar nada** e, no caminho, remonta o cabeçalho do bloco de cada share para calcular a dificuldade atingida. Funciona com qualquer pool e qualquer minerador, sem depender de API de pool nem do firmware do aparelho. A porta escolhe a pool:

  | Porta | Pool |
  |---|---|
  | 3333 | public-pool.io |
  | 3334 | solo.ckpool.org (bom para Bitaxe) |
  | 3335 | pool.nerdminers.org (aceita a dificuldade baixíssima dos ESP32) |
  | 3337 | OCEAN |

- **Painel** (`src/painel.js`), em `http://IP-DO-SERVIDOR:3000`, com quatro telas:
  - **Fazenda:** recordes, hashrate e a lista de workers com o último share.
  - **Rede Bitcoin:** último bloco, ajuste de dificuldade, halving e prêmio em jogo.
  - **Histórico:** gráficos, hall da fama e consumo de energia.
  - **Quase bloco:** nosso melhor hash × hash do último bloco, com os zeros lado a lado.

  Para uma tela ligada ao servidor, use `?kiosk`: as telas alternam sozinhas e o cursor some.
- **Extras opcionais:**
  - **Sirene:** Arduino com LEDs e alto-falante, ver `extras/sirene`.
  - **Cubo GeekMagic SmallTV:** placar de 240×240 na mesa (`src/cubo.py`).
  - **Widget KWGT para Android:** ver `extras/kwgt`.

## Idiomas

O painel, o cubo, o widget e o instalador funcionam em **português (pt-BR)** e **inglês**.

- **`LANGUAGE=pt-BR`** em `/etc/mineracao.env` fixa o idioma. Vazio, o painel segue o idioma do navegador, e o cubo e o widget ficam em inglês.
- O botão **PT | EN** no topo do painel troca o idioma e lembra a escolha naquele navegador.
- **`?lang=pt` ou `?lang=en`** na URL do painel ou do widget força o idioma só ali.
- **`CURRENCY=BRL`** ou **`CURRENCY=USD`** define a moeda dos valores (cotação, prêmio, conta de luz). O padrão é BRL em pt-BR e USD nos outros casos.

## Instalação

Precisa de Linux com systemd e Node.js 16 ou mais novo.

```bash
git clone https://github.com/Modanez/HomeMinerProxy.git
cd HomeMinerProxy
sudo LANGUAGE=pt-BR bash install.sh
```

Na primeira vez, o instalador pergunta o endereço de bitcoin dos mineradores e cria `/etc/mineracao.env`. Todas as opções estão comentadas em `config/mineracao.env.example`. Depois de editar:

```bash
sudo systemctl restart mineracao-proxy mineracao-painel
```

Para atualizar, rode `git pull && sudo bash install.sh` de novo. A configuração e os dados (recordes, histórico) são mantidos.

## Apontando os mineradores

Usuário: `SEU_ENDERECO.nome-do-worker`, com qualquer senha (ex.: `x`). O nome depois do ponto é o que aparece no painel.

| Minerador | Pool | Porta |
|---|---|---|
| cpuminer (`minerd`) | `stratum+tcp://IP-DO-SERVIDOR` | 3333 |
| NerdMiner / ESP32 | `IP-DO-SERVIDOR` | 3335 |
| Bitaxe | `IP-DO-SERVIDOR` | 3334 (configure `solo.ckpool.org:3333` como pool reserva no AxeOS) |

Reserve um IP fixo para o servidor no roteador (DHCP estático): se o IP mudar, todos os mineradores perdem a pool.

```bash
minerd -a sha256d -o stratum+tcp://192.168.0.10:3333 -u SEU_ENDERECO.notebook -p x
```

## Cubo GeekMagic (opcional)

Preencha `CUBE_IP` em `/etc/mineracao.env` e rode o `install.sh` de novo. O placar é atualizado a cada 5 minutos. Um recorde novo aparece na hora, com a tela "NOVO RECORDE!". O cubo precisa estar no firmware original da GeekMagic, que tem o modo álbum de fotos.

## Desenvolvimento

```bash
npm run check   # sintaxe de tudo
npm test        # testes (Node 18+ e Python 3; os do cubo precisam do Pillow)
```

O que os testes cobrem:
- **Matemática do share:** conferida com o **bloco gênese** e o **bloco 1** reais. Se a ordem dos bytes estiver errada, o hash não bate.
- **Proxy:** sobe entre uma pool falsa e um minerador de teste.
- **Painel:** sobe sem acesso à internet.
- **Tradução:** cobre a página inteira.

Os textos da página estão em português no código. A versão em inglês é gerada pela tabela em `src/i18n.js`. Se você mudar um texto em português, atualize a tabela: o teste `tests/i18n.test.js` avisa se algum trecho sumir.

## Segurança

- Use só o **endereço público** de bitcoin. Nenhuma parte do projeto pede seed ou chave privada.
- As portas do proxy (3333–3337) e do painel (3000) são para a rede de casa. Não as exponha na internet. Para acesso de fora, prefira uma VPN como Tailscale. As estatísticas brutas (`3336`) só escutam em `127.0.0.1`.

## Apoie o projeto

Se o projeto deixou a sua loteria do bloco mais divertida, doações são bem-vindas. ⚡

**Bitcoin (on-chain):** `bc1qstq0tx86kwgskzxte0l7a6ewtyp0y4z8w4jd2w`

Ideias, issues e pull requests também são muito bem-vindos.

## Licença

MIT

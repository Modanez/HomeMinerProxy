# ⛏️ Fazenda de Mineração (HomeMinerProxy)

[English](README.md) · **Português**

[![CI](https://github.com/Modanez/HomeMinerProxy/actions/workflows/ci.yml/badge.svg)](https://github.com/Modanez/HomeMinerProxy/actions/workflows/ci.yml)

Proxy Stratum e painel para **mineração solo caseira**: Bitaxe, NerdMiner, ESP32, cpuminer no notebook ou no celular. Tudo roda num computador pequeno da casa (Odroid, Raspberry Pi, Orange Pi ou qualquer Linux), **sem dependências** além do Node.js.

A ideia é transformar a "loteria do bloco" em algo divertido de acompanhar: cada share aparece na hora, os recordes disparam confete e sirene, e uma tela mostra o abismo entre o nosso melhor hash e o hash do último bloco da rede.

![Novo recorde da fazenda: confete no painel (a sirene do Arduino toca junto)](docs/img/record.gif)

![Tela da fazenda em português: recorde, hashrate, chance e cada worker com o último share](docs/img/painel.png)

<details>
<summary>Mais imagens</summary>

| Quase bloco | Histórico |
|---|---|
| ![Nosso melhor hash × hash do último bloco](docs/img/almost-a-block.png) | ![Hashrate, evolução do recorde, hall da fama e conta de luz](docs/img/history.png) |

| Celular | Cubo GeekMagic |
|---|---|
| ![Painel no celular](docs/img/mobile.png) | ![Placar no cubo e tela de recorde](docs/img/cube.png) |

As imagens usam dados de demonstração. As telas extras estão em inglês; o painel inteiro também funciona em português.
</details>

## Como funciona

```
Bitaxe / NerdMiner / cpuminer ──► proxy (porta 3333, 3334, 3335…) ──► pool
                                    │
                                    └─► calcula a dificuldade de cada share ──► painel web, sirene, cubo
```

- **Proxy Stratum** (`src/proxy.js`): cada minerador se conecta no servidor da casa em vez da pool. O proxy repassa tudo **sem alterar nada** e, no caminho, remonta o cabeçalho do bloco de cada share para calcular a dificuldade atingida. Funciona com qualquer pool e qualquer minerador, sem depender de API de pool nem do firmware do aparelho. A porta escolhe a pool:

  | Porta | Pool | Taxa |
  |---|---|---|
  | 3333 | public-pool.io | 0% |
  | 3334 | solo.ckpool.org (EUA) | 2% |
  | 3335 | pool.nerdminers.org | 0% |
  | 3340 | pool.bitronics.store (porta 3334 de NerdMiner) | 0% |
  | 3341 | pool.bitronics.store porta de ASIC: solo (`ENDEREÇO.worker`) ou SOLO Group (`ENDEREÇO.worker#grupo`) | 0% solo · 1% grupo, bloco dividido no grupo |
  | 3337 | OCEAN (pagamento dividido, não é solo) | ver ocean.xyz |
  | 3338 | solo.atlaspool.io (anycast, com servidor em São Paulo) | 1,5% do subsídio |
  | 3339 | eusolo.ckpool.org (Europa) | 2% |

  Qualquer outra pool Stratum V1 pode ser acrescentada no `PROXY_ROUTES` (veja a configuração).

  **Failover:** a maioria das portas tem uma pool reserva. Se a pool principal parar de responder, os mineradores que se conectarem vão para a reserva, e o painel mostra um aviso. Uma checagem testa a principal a cada minuto; quando ela volta, os mineradores voltam junto. A reserva sempre paga o mesmo endereço, porque o usuário que o minerador envia passa sem alteração.

- **Painel** (`src/painel.js`), em `http://IP-DO-SERVIDOR:3000`, com cinco telas:
  - **Fazenda:** recordes, hashrate e a lista de workers com o último share.
  - **Rede Bitcoin:** último bloco, ajuste de dificuldade, halving e prêmio em jogo.
  - **Histórico:** gráficos, hall da fama e consumo de energia.
  - **Quase bloco:** nosso melhor hash × hash do último bloco, com os zeros lado a lado. O botão 🎟️ transforma o melhor hash do dia num bilhete de loteria ("NÃO PREMIADO", até o dia em que for) para compartilhar ou salvar.
  - **Sorte:** o melhor share de cada worker comparado com o que o trabalho dele deveria render pela estatística (1× é o normal, 2× é o dobro de sorte), um histograma das dificuldades de todos os shares contra a curva teórica, o **Campeonato da semana** (ordenado por sorte relativa para o vovô devkit disputar de igual para igual com um ASIC) e as **Conquistas da fazenda**.

  O painel também atende na **porta 80**, então `http://homeminer.local` (ou o IP da placa) funciona sem o `:3000`; os links antigos com `:3000` continuam valendo. `HTTP80=0` desliga, se outro servidor web usar a porta 80.
  Para uma tela ligada ao servidor, use `?kiosk`: as telas alternam sozinhas e o cursor some. Nas imagens prontas (ou em qualquer Debian/Armbian com systemd), ⚙️ Configurações → Fazenda → **Tela ligada nesta placa (quiosque)** (`KIOSK=1`) faz isso sozinho: na primeira vez instala um navegador mínimo em tela cheia (cage + Chromium, uns 300 MB, alguns minutos com internet) e daí em diante abre o `?kiosk` na tela do HDMI em todo boot, no lugar do login de texto (Ctrl+Alt+F2 ainda dá um terminal). Desligar devolve a tela.
- **Extras opcionais:**
  - **Bot do Telegram:** avisos no celular de recorde da fazenda, worker parado, failover de pool e dinheiro entrando na carteira (um bloco achado!), resumo diário e comandos como `/status` e `/sorte`. Veja [Bot do Telegram](#bot-do-telegram-opcional).
  - **Sirene:** Arduino com LEDs e alto-falante, ver `extras/sirene`.
  - **Cubo GeekMagic SmallTV:** placar de 240×240 na mesa (`src/cubo.py`).
  - **Widget KWGT para Android:** ver `extras/kwgt`.

## Tela de configurações

O botão ⚙️ no topo do painel (ou `http://IP-DO-SERVIDOR:3000/config`) muda as opções do dia a dia sem editar arquivo: endereço de bitcoin, idioma, moeda, preço do kWh, se a carteira aparece ou não, o minerador que roda no servidor (`LOCAL_WORKER`), os workers que não acendem a luz vermelha (`ALARM_IGNORE`), o consumo em watts (`WATTS`) e o hashrate esperado (`EXPECTED`) de cada worker, o IP do cubo e o bot do Telegram. Tem botões para testar o cubo, mandar uma mensagem de teste no Telegram e **baixar ou restaurar um backup completo** (configurações, recordes, histórico e workers num arquivo JSON único).

- **PIN:** para salvar, a tela pede o `SETTINGS_PIN`. O `install.sh` cria um, mostra no final e guarda em `/etc/mineracao.env`. No Docker, defina o `SETTINGS_PIN` no `mineracao.env`.
- **Onde fica salvo:** em `settings.json`, junto com os recordes e o histórico. Ele vale por cima do `/etc/mineracao.env`; o que você não mudar na tela continua vindo do arquivo.
- **Para aplicar:** depois de salvar, o painel reinicia sozinho e as páginas abertas recarregam. O cubo percebe a mudança e reinicia também.

## Idiomas

O painel, o cubo, o widget e o instalador funcionam em **português (pt-BR)** e **inglês**.

- **`LANGUAGE=pt-BR`** em `/etc/mineracao.env` fixa o idioma. Vazio, o painel segue o idioma do navegador, e o cubo e o widget ficam em inglês.
- O botão **PT | EN** no topo do painel troca o idioma e lembra a escolha naquele navegador.
- **`?lang=pt` ou `?lang=en`** na URL do painel ou do widget força o idioma só ali.
- **`CURRENCY=BRL`** ou **`CURRENCY=USD`** define a moeda dos valores (cotação, prêmio, conta de luz). O padrão é BRL em pt-BR e USD nos outros casos.
- **`POWER_PRICE_KWH=0.90`** define o preço do kWh da sua conta de luz, nessa moeda. O padrão é R$ 0,90 ou US$ 0,15. Junto com o `WATTS` de cada worker, ele calcula a estimativa da conta de luz.

## Cartão SD pronto para gravar (o jeito mais fácil)

Sem terminal. Cada release traz imagens para **Raspberry Pi 3/4/5**, **Orange Pi Zero 3** e **Odroid-C2**:

1. Baixe o `homeminer-<placa>.img.xz` da [release mais recente](https://github.com/Modanez/HomeMinerProxy/releases/latest).
2. Grave num cartão SD (8 GB ou mais; cartão "High Endurance" dura mais) com o [Raspberry Pi Imager](https://www.raspberrypi.com/software/) ("Use custom") ou o [balenaEtcher](https://etcher.balena.io/).
3. Coloque o cartão na placa, **ligue o cabo de rede** e ligue a energia. O primeiro boot leva alguns minutos (ele expande o cartão).
4. No celular ou no computador, abra **http://homeminer.local:3000**. Se o nome não abrir, use o IP que o roteador mostra para "homeminer". O assistente de primeira configuração pergunta o idioma, o seu endereço de bitcoin, um PIN de administração, **se a placa também vai minerar** (as imagens vêm com o cpuminer; escolha os núcleos e o nome do worker) e o preço da energia. Dá para ligar ou desligar a mineração depois em ⚙️ Configurações → Mineradores.
5. Aponte os mineradores para `homeminer.local` (ou o IP), nas portas que aparecem no fim do assistente. Reserve um IP fixo para a placa no roteador.

**Sem cabo? Rede de configuração.** Se a placa ligar sem rede nenhuma por 90 segundos e tiver um Wi-Fi que funcione como ponto de acesso (o Wi-Fi embutido do Raspberry Pi, ou um adaptador USB com modo AP: RT5370/RT3070, MT7610U/MT7612U, AR9271; muitos Realtek RTL8188 baratos não têm), ela cria a rede aberta **HomeMiner-Setup**. Conecte o celular: o aviso "entrar na rede" (ou http://10.42.0.1:3000) abre o assistente, que só pergunta o Wi-Fi de casa. O HomeMiner sai da HomeMiner-Setup e entra na sua rede; volte o celular para ela e continue em http://homeminer.local:3000. Se a senha estiver errada, a HomeMiner-Setup volta em cerca de um minuto mostrando o motivo. Depois, se a placa perder a rede, a HomeMiner-Setup volta (abrindo ⚙️ Configurações → 🌐 Rede, com o PIN), e a cada 10 minutos sem ninguém conectado ela tenta de novo o Wi-Fi salvo. `HOTSPOT=0` desliga.

**Som de recorde:** uma fanfarra curta toca no navegador a cada recorde novo (🔊/🔇 na barra superior). O navegador precisa de um toque na página antes; no modo quiosque, abra o Chromium com `--autoplay-policy=no-user-gesture-required`.

**Aba 🌐 Rede** (⚙️ Configurações, com PIN): **Wi-Fi** — procure as redes e conecte, depois tire o cabo (precisa de um adaptador Wi-Fi; nas imagens do Orange Pi e do Odroid o NetworkManager cuida só do Wi-Fi e o cabo continua com a configuração dele); **Tailscale** — um toque para abrir o painel de fora de casa sem abrir portas no roteador: toque em *Conectar ao Tailscale*, abra o link de autorização, entre na sua conta do Tailscale (grátis) e aprove o aparelho. Depois, no celular com o app do Tailscale ligado, abra `http://homeminer:3000`. Vem instalado e desligado; *Desconectar* sai da conta e desliga de novo. **SSH** — cole a sua chave pública (`~/.ssh/id_ed25519.pub`) e ligue: só com chave, login por senha desligado, depois `ssh root@homeminer.local`. Se o SSH já estava ligado por fora do painel, a configuração dele não é mexida e dá só para acrescentar chaves.

As placas não têm bateria de relógio, então ligam com a hora errada até sincronizar pela internet. O painel mostra "Acertando o relógio…" e espera (até 10 minutos) antes de gravar qualquer coisa, para o histórico e os recordes ficarem com as datas certas.

As atualizações saem em ⚙️ Configurações → 💾 Backup → **Atualizar agora**. Por segurança, o SSH vem desligado nas imagens; ligue em 🌐 Rede com a sua chave (ou, no Orange Pi e no Odroid: monitor e teclado, login `root`, senha `1234`, escolha uma nova e rode `systemctl enable --now ssh`). Na imagem do Raspberry Pi o SSH vem desligado como de costume; dá para ligar nas configurações do Raspberry Pi Imager na hora de gravar.

## Instalação

Precisa de Linux com systemd e Node.js 16 ou mais novo.

```bash
git clone https://github.com/Modanez/HomeMinerProxy.git
cd HomeMinerProxy
sudo LANGUAGE=pt-BR bash install.sh
```

Na primeira vez, o instalador pergunta o endereço de bitcoin dos mineradores e cria `/etc/mineracao.env`. Aperte Enter para pular: o painel abre um **assistente de primeira configuração no navegador** (`http://NOME-DO-SERVIDOR.local:3000` ou o IP do servidor), que pergunta o idioma, o endereço de bitcoin, um PIN de administração escolhido por você e o preço da energia, grava tudo e reinicia sozinho. Todas as opções estão comentadas em `config/mineracao.env.example`. Depois de editar:

```bash
sudo systemctl restart mineracao-proxy mineracao-painel
```

Para atualizar, use o botão **⬆ Atualizar agora** em ⚙️ Configurações → 💾 Backup (ele mostra a versão instalada e a mais recente, e pede o PIN), ou rode `git pull && sudo bash install.sh` de novo. A configuração e os dados (recordes, histórico) são mantidos.

### Com Docker

```bash
git clone https://github.com/Modanez/HomeMinerProxy.git
cd HomeMinerProxy
cp config/mineracao.env.example mineracao.env   # preencha BTC_ADDRESS e, se quiser, LANGUAGE=pt-BR e TZ=America/Sao_Paulo
docker compose up -d
```

O painel fica em `http://IP-DO-SERVIDOR:3000`, e as portas do proxy são as mesmas de cima. Os dados (recordes, histórico) ficam no volume `data`. Para atualizar: `git pull && docker compose up -d --build`.

- **Cubo GeekMagic:** preencha `CUBE_IP` e rode `docker compose --profile cubo up -d`.
- **Tela de configurações:** defina `SETTINGS_PIN` no `mineracao.env` para poder salvar.
- **Sirene do Arduino:** descomente as linhas `devices` do serviço `painel` no `compose.yaml`.
- **Minerar com o mesmo computador:** `docker compose --profile minerador up -d` acrescenta um contêiner com o cpuminer apontado para o proxy. Ele aparece no painel como `LOCAL_WORKER` (padrão `docker`); os núcleos ficam em `MINER_THREADS` (padrão: todos menos um). O hashrate vem dos shares, como o de qualquer minerador.
- **Aba 🌐 Rede:** Wi-Fi, SSH e Tailscale são do host, então no Docker a aba explica como configurar por lá (com o Tailscale no host, o painel abre de fora em `http://NOME-DO-HOST:3000`).

## Qual pool para cada minerador?

| Minerador | Hashrate | Porta recomendada | Por quê |
|---|---|---|---|
| NerdMiner, placas ESP32 | ~50–400 kH/s | **3335** nerdminers ou **3340** bitronics | Aceitam a dificuldade minúscula dos shares deles (a maioria das outras pools recusa, "difficulty too low") e uma é a reserva da outra. A pool.nerdminers.org parece aceitar uma conexão por IP de casa: com dois NerdMiners, ponha o segundo na 3340 |
| cpuminer no PC, celular ou placa tipo Raspberry | ~1–20 MH/s | **3333** public-pool | Sem taxa e com dificuldade mínima 1 |
| Bitaxe e outros ASICs pequenos | ~0,4–10 TH/s | **3334** ckpool ou **3338** atlaspool | Pools solo consagradas. Escolha a de menor latência onde você mora. O proxy conta os shares aceitos e recusados de cada worker (`curl localhost:3336/stats` no servidor), então dá para comparar. No Brasil, a AtlasPool tem servidor em São Paulo |
| Qualquer minerador, na Europa | | **3339** ckpool EU | A mesma pool da 3334, com servidores mais perto |
| Você prefere pagamentos pequenos e regulares em vez da loteria | | **3337** OCEAN | Não é solo: a recompensa é dividida entre todos |

A AtlasPool exige dificuldade mínima de 2.000 (uns 400 GH/s), então ESP32 não funciona lá.

## Apontando os mineradores

Usuário: `SEU_ENDERECO.nome-do-worker`, com qualquer senha (ex.: `x`). O nome depois do ponto é o que aparece no painel.

| Minerador | Pool | Porta |
|---|---|---|
| cpuminer (`minerd`), [passo a passo](#minerando-com-o-cpuminer-passo-a-passo) | `stratum+tcp://IP-DO-SERVIDOR` | 3333 |
| NerdMiner / ESP32 | `IP-DO-SERVIDOR` | 3335 |
| Bitaxe | `IP-DO-SERVIDOR` | 3334 (configure `solo.ckpool.org:3333` como pool reserva no AxeOS) |

Reserve um IP fixo para o servidor no roteador (DHCP estático): se o IP mudar, todos os mineradores perdem a pool.

```bash
minerd -a sha256d -o stratum+tcp://192.168.0.10:3333 -u SEU_ENDERECO.notebook -p x
```

## Telemetria do Bitaxe (API do AxeOS)

O painel lê cada Bitaxe direto da API local do AxeOS (firmware 2.14 e 2.15): hashrate medido (1 min, 10 min, 1 h e esperado), temperatura do chip e do regulador, consumo e J/TH, fan, frequência e tensão do chip, pool em uso (principal ou reserva), melhor da sessão, tempo ligado e sinal do Wi-Fi.

1. Reserve um IP fixo para cada Bitaxe no roteador.
2. Em ⚙️ Configurações → Mineradores → **Bitaxe (API do AxeOS)**, escreva `nome=IP` de cada um (`bitaxe1=192.168.0.140, bitaxe2=192.168.0.141`), ou toque em **Procurar na rede** e **Usar estes**. **Testar** mostra modelo, firmware, hashrate, temperatura e watts. Use o nome do worker (o que vem depois do ponto no usuário da pool).
3. Salve. A tela da fazenda ganha um cartão **Bitaxe**, a linha do worker mostra temperatura e watts, e o consumo medido substitui a estimativa do `WATTS` no custo de energia (uma tomada com medidor continua tendo prioridade).

O `/status` do Telegram ganha uma linha por Bitaxe, e o MQTT / Home Assistant ganha sensores de hashrate, temperatura, consumo e fan de cada um.

**Alertas** (Telegram, uma vez quando começam e outra quando terminam; MQTT, um `binary_sensor` por alerta e por Bitaxe):

| Alerta | Quando | Padrão (Configurações → Mineradores) |
| --- | --- | --- |
| Chip quente | chip acima do limite em 2 leituras seguidas | 68 °C (`BITAXE_TEMP_MAX`) |
| Regulador quente | regulador de tensão acima do limite em 2 leituras | 95 °C (`BITAXE_VR_MAX`; o próprio firmware para de minerar acima de 105 °C) |
| Hashrate baixo | média de 10 min abaixo de uma fração do esperado por 10 min (fora os primeiros 15 min depois de ligar) | 70% (`BITAXE_HASH_MIN`) |
| Na pool reserva | o AxeOS passou para a pool de fallback | — |
| Falha | falha de energia, de hardware ou modo de superaquecimento | — |
| Sem resposta | 3 leituras seguidas sem resposta | 90 s |
| Reiniciou / achou bloco | o tempo ligado voltou a zero / o AxeOS informa um bloco | uma mensagem |

O `ALARM_IGNORE` também silencia um Bitaxe (menos o bloco encontrado).

**Ações** (⚙️ Configurações → Mineradores → *Ações nos Bitaxe*, com o PIN; no Telegram, `/reiniciar`, `/pausar`, `/retomar` + o nome):

- **Reiniciar, identificar** (a tela pisca), **pausar e retomar**.
- **Fan:** automático com temperatura-alvo (50–70 °C), ou fixo entre 20% e 100%.
- **Apontar para o proxy:** mostra *hoje → vai ficar* e grava o IP deste servidor na rede de casa, a porta ASIC (atlaspool, senão ckpool), `endereço.nome` e a reserva `solo.ckpool.org:3333`. Depois confere na releitura e reinicia o Bitaxe. Se o servidor tiver mais de uma rede, `BITAXE_SERVER_IP` escolhe o IP.

O cartão do painel mostra a última ação. Overclock, firmware e Wi-Fi do Bitaxe nunca são mexidos por aqui.

**Unidade de temperatura:** ⚙️ Configurações → Fazenda → *Unidade de temperatura* (`TEMP_UNIT=C` ou `F`) passa o painel, o Telegram e os limites de alerta dos Bitaxe (digitados na unidade escolhida) para °F. O MQTT continua em °C, porque o Home Assistant converte sozinho. O painel só lê (`GET /api/system/info` a cada 30 s): overclock, firmware e o Wi-Fi do Bitaxe ficam no AxeOS. A API do AxeOS não tem senha e só responde na rede de casa, então nunca exponha um Bitaxe à internet: de fora de casa, abra o painel pelo Tailscale.

## Minerando com o cpuminer (passo a passo)

O [cpuminer](https://github.com/pooler/cpuminer) (`minerd`) minera bitcoin em qualquer processador: notebook, PC velho, Raspberry Pi, celular Android. Seja honesto com as chances: uma CPU faz poucos MH/s, então um bloco é uma loteria de uma em bilhões por ano. A graça é ver cada share aparecer no painel, com direito a recorde. Na fazenda deste projeto, um MacBook M2 faz uns 9 MH/s, um tablet Android uns 4 MH/s e um Odroid-C2 uns 2,7 MH/s.

Use a porta **3333** (public-pool, dificuldade mínima 1). Nos comandos abaixo, troque `IP-DO-SERVIDOR` pelo IP da máquina que roda o proxy, `SEU_ENDERECO` pelo seu endereço de bitcoin e `notebook` pelo nome que você quer ver no painel.

<details>
<summary><b>Linux</b> (Ubuntu, Debian, Armbian, Raspberry Pi OS)</summary>

```bash
sudo apt install -y git build-essential automake autoconf pkg-config libcurl4-openssl-dev
git clone https://github.com/pooler/cpuminer.git
cd cpuminer
./autogen.sh
./configure CFLAGS="-O3"
make -j"$(nproc)"
sudo make install        # instala /usr/local/bin/minerd
minerd -a sha256d -o stratum+tcp://IP-DO-SERVIDOR:3333 -u SEU_ENDERECO.notebook -p x
```

**Rodar como serviço** (sobe no boot e reinicia se cair), por exemplo na mesma máquina do painel. Crie `/etc/systemd/system/minerd.service`:

```ini
[Unit]
Description=cpuminer
After=network-online.target mineracao-proxy.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/minerd -a sha256d -o stratum+tcp://127.0.0.1:3333 -u SEU_ENDERECO.odroid -p x
Nice=19
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

Depois rode `sudo systemctl daemon-reload && sudo systemctl enable --now minerd`. Se o serviço se chama `minerd` e roda na máquina do painel, coloque `LOCAL_WORKER=odroid` (o nome do worker) em `/etc/mineracao.env`: o painel lê o hashrate direto do log e mostra a temperatura da CPU ao lado.
</details>

<details>
<summary><b>macOS</b> (Intel ou Apple Silicon)</summary>

Instale o [Homebrew](https://brew.sh) antes e depois rode:

```bash
xcode-select --install   # compiladores, se ainda não tiver
brew install git automake autoconf pkg-config curl
git clone https://github.com/pooler/cpuminer.git
cd cpuminer
./autogen.sh
./nomacro.pl             # necessário com o Clang, o compilador do macOS
./configure CFLAGS="-O3"
make -j"$(sysctl -n hw.ncpu)"
caffeinate -i ./minerd -a sha256d -o stratum+tcp://IP-DO-SERVIDOR:3333 -u SEU_ENDERECO.macbook -p x
```

O `caffeinate -i` impede o Mac de dormir enquanto minera. Para parar, feche o terminal ou aperte Ctrl+C.
</details>

<details>
<summary><b>Android</b> (Termux)</summary>

Instale o **Termux pelo F-Droid** (a versão da Play Store está desatualizada) e rode:

```bash
pkg update
pkg install -y git clang make automake autoconf pkg-config libcurl
git clone https://github.com/pooler/cpuminer.git
cd cpuminer
./autogen.sh
./nomacro.pl
./configure CFLAGS="-O3"
make -j"$(nproc)"
termux-wake-lock         # mantém a CPU acordada com a tela apagada
./minerd -a sha256d -o stratum+tcp://IP-DO-SERVIDOR:3333 -u SEU_ENDERECO.celular -p x
```

Nas configurações do Android, deixe o uso de bateria do Termux como **Sem restrições**, senão o sistema mata o minerador depois de um tempo. Deixe o aparelho no carregador e num lugar onde ele consiga esfriar.
</details>

<details>
<summary><b>Windows</b></summary>

Baixe a versão pronta para Windows (`pooler-cpuminer-2.5.1-win64.zip`) na [página do projeto no SourceForge](https://sourceforge.net/projects/cpuminer/files/), extraia, abra um terminal nessa pasta e rode:

```bat
minerd.exe -a sha256d -o stratum+tcp://IP-DO-SERVIDOR:3333 -u SEU_ENDERECO.pc -p x
```

O antivírus pode marcar qualquer minerador como software indesejado. Se acontecer, libere só essa pasta.
</details>

**Opções úteis**
- `-t 2` usa só 2 threads (o padrão é usar todos os núcleos). Deixa a máquina mais leve e mais fria.
- `-q` esconde as linhas de hashrate de cada thread. Não use com `LOCAL_WORKER`, porque o painel lê essas linhas.
- `-R 10` espera 10 segundos para reconectar depois de um erro de rede (o padrão é 30). Por padrão ele tenta para sempre, que é o que você quer.

**Como saber se funcionou:** o `minerd` mostra `accepted: 1/1 (100.00%)` e, no painel, o worker aparece com ⚡ (conectado pelo proxy). Uma CPU de poucos MH/s leva alguns minutos por share na dificuldade 1, então o primeiro pode demorar.

## Bot do Telegram (opcional)

1. No Telegram, abra o **@BotFather**, mande `/newbot`, escolha um nome e copie o token que ele devolve.
2. Coloque em `/etc/mineracao.env` como `TELEGRAM_BOT_TOKEN=...` e rode `sudo systemctl restart mineracao-painel`.
3. Mande `/start` para o seu bot. Ele responde com o id do chat.
4. Coloque esse id em `TELEGRAM_CHAT_ID=...` e reinicie o painel de novo.

O bot avisa:
- **Recorde da fazenda:** um novo melhor share da fazenda inteira.
- **Worker parado / de volta:** quando um worker fica vermelho no painel, e quando ele volta.
- **Failover de pool:** quando uma porta vai para a pool reserva, e quando volta para a principal.
- **Dinheiro na carteira:** qualquer pagamento para o seu endereço. Um bloco solo chega como 🎉 **ACHAMOS UM BLOCO!**
- **Conquistas:** avisa quando a fazenda desbloqueia um marco novo (ex.: primeiro share de dificuldade 1.000, 100 mil shares, uma semana sem parar ou o troféu vovô).
- **Resumo diário:** às 21h por padrão (`TELEGRAM_DAILY`), com a imagem do bilhete de loteria do dia (e o anúncio do campeão da semana no domingo).
- **Backup semanal (opcional):** com ⚙️ Configurações → Telegram → *Backup semanal no Telegram* ligado (`TELEGRAM_BACKUP=1`), todo domingo, na hora do resumo, o bot manda o arquivo de backup sem som. O `/backup` manda na hora. É o mesmo arquivo do 💾 Backup (restaure por lá) e ele tem as chaves e senhas salvas, então deixe no seu chat privado com o bot.

Comandos: `/status`, `/workers`, `/sorte`, `/recordes`, `/campeonato`, `/conquistas`, `/tomada` (`ligar`/`desligar`/`reiniciar`), `/bilhete` (imagem do bilhete de hoje), `/backup` (arquivo de backup da configuração), `/ajuda`. A imagem do bilhete precisa de Python com Pillow no servidor (o instalador instala; a imagem Docker já tem); sem isso, o resumo vai só em texto. O bot só responde aos chats do `TELEGRAM_CHAT_ID`. Ele usa long polling, então nada da sua rede precisa ficar exposto. No `QUIET_HOURS`, os avisos chegam sem som.

## Cubo GeekMagic (opcional)

Preencha `CUBE_IP` em `/etc/mineracao.env` e rode o `install.sh` de novo. O placar é atualizado a cada 5 minutos. Um recorde novo aparece na hora, com a tela "NOVO RECORDE!". O cubo precisa estar no firmware original da GeekMagic, que tem o modo álbum de fotos.

## Tomada Inteligente — SmartLife / Tuya (opcional)

Se o seu minerador (ou um ventilador enquanto o Bitaxe não chega) estiver ligado numa tomada inteligente Wi-Fi **SmartLife / Tuya** com medidor de consumo, você pode conectá-la direto pela tela de configurações (`/config`) ou no `/etc/mineracao.env`:

1. Crie uma conta gratuita em [iot.tuya.com](https://iot.tuya.com) -> **Cloud** -> **Development** -> **Create Cloud Project** (Data Center: **Western America** para o Brasil/Américas).
2. Em **Link Tuya App Account**, escaneie o QR Code pelo app **SmartLife** (*Eu -> ícone de scanner no topo direito*) e ative a API **IoT Core** em Service API.
3. Cole `TUYA_CLIENT_ID`, `TUYA_SECRET` e `TUYA_DEVICE_ID` na tela `/config` e clique em **Testar tomada**.
4. Escolha `TUYA_WORKER`:
   - **Só monitorar (não somar nos mineradores)**: exibe os Watts, Volts e estado (ligada/desligada) no card de Energia sem somar na conta dos mineradores (ideal enquanto a tomada está no ventilador).
   - **Worker específico (ex.: `bitaxe`) ou Fazenda inteira (`*`)**: substitui a estimativa fixa de `WATTS` pelo consumo real medido ao vivo pela tomada.
5. Controle pelo Telegram (`/tomada`, `/tomada ligar`, `/tomada desligar`, `/tomada reiniciar`) ou defina `TUYA_WATCHDOG_MIN` (ex.: `30`) para reiniciar a tomada sozinho se o minerador ficar 30 minutos sem enviar shares.

### Tomadas Sonoff (rede local)

As tomadas Sonoff são controladas **direto pela rede de casa**, pelo modo LAN / DIY delas: sem nuvem, sem conta de desenvolvedor e sem credenciais.

1. Ligue o **modo DIY / LAN** do seu Sonoff, seguindo o guia da Sonoff para o seu modelo (procure por "DIY mode" em sonoff.tech). Modelos sem modo DIY ainda não são suportados.
2. Reserve um IP fixo para a tomada no roteador (reserva de DHCP).
3. Em `/config` → 🔌 **Tomada**, escolha **Sonoff (rede local)**, digite o IP, escolha o minerador ligado nela e clique em **Adicionar tomada**, depois em **Testar tomada**.

Tomadas Sonoff e SmartLife/Tuya convivem na mesma lista. As duas ganham os botões **Ligar / Desligar / Reiniciar** na tela Histórico (protegidos pelo PIN), os comandos do Telegram com o nome do worker (`/tomada reiniciar devkit`) e o watchdog. A maioria dos Sonoff não informa o consumo no modo DIY, então a conta de luz continua usando a estimativa do `WATTS` para eles.

**Segurança:** a tomada ligada ao `LOCAL_WORKER` (o servidor que roda o painel) só pode ser ligada pelo painel ou pelo Telegram, nunca desligada ou reiniciada: isso apagaria o painel sem como religar. Um nome de tomada que o bot não conhece é recusado, em vez de cair em outra tomada.

## Home Assistant / MQTT (opcional)

Defina `MQTT_URL` (ex.: `mqtt://homeassistant.local:1883` ou `mqtts://host:8883`), `MQTT_USER`, `MQTT_PASS` e `MQTT_TOPIC` (padrão: `homeminerproxy`) em `/etc/mineracao.env` ou direto pela tela de configurações (`/config`).

- **Auto-Discovery sem YAML:** publica 11 sensores (`hashrate`, `best_difficulty`, `best_worker`, `workers_active`, `workers_stopped`, `shares_today`, `power_watts`, `energy_kwh_month`, `cost_month`, `weekly_leader`, `achievements_unlocked`) e 1 sensor binário (`pool_failover`) em `homeassistant/.../config`, criando sozinho o dispositivo **Fazenda de Mineração** no Home Assistant (já com classes de potência, energia e custo para o Painel de Energia do HA).
- **Estado e tópicos por worker:** publica `<prefixo>/state` e `<prefixo>/worker/<nome>` (JSON retido), além de `<prefixo>/availability` (`online` / `offline` com *Last Will & Testament*).
- **Eventos instantâneos (`<prefixo>/event`):** publica eventos JSON em tempo real (`farm_record`, `personal_record`, `worker_offline`, `worker_online`, `pool_failover`, `pool_recovered`, `wallet_received`, `block_found`, `achievement_unlocked`) para acionar tomadas inteligentes, fitas WLED/Hue, relógios AWTRIX ou caixas de som da casa.

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

Documentação de arquitetura e APIs:
- **Modelo C4 (Contexto, Contêineres, Componentes e Fluxos):** [`docs/c4/README.pt-BR.md`](docs/c4/README.pt-BR.md)
- **Registros de Decisão de Arquitetura (ADRs):** [`docs/adr/README.pt-BR.md`](docs/adr/README.pt-BR.md)
- **Coleções Postman (APIs HTTP):** [`docs/postman/README.pt-BR.md`](docs/postman/README.pt-BR.md)

## Segurança

- Use só o **endereço público** de bitcoin. Nenhuma parte do projeto pede seed ou chave privada.
- As portas do proxy (3333–3341) e do painel (3000) são para a rede de casa. Não as exponha na internet. Para acesso de fora, prefira uma VPN como Tailscale. As estatísticas brutas (`3336`) só escutam em `127.0.0.1`.

## Apoie o projeto

Se o projeto deixou a sua loteria do bloco mais divertida, doações são bem-vindas. ⚡

**Bitcoin (on-chain):** `bc1qstq0tx86kwgskzxte0l7a6ewtyp0y4z8w4jd2w`

Ideias, issues e pull requests também são muito bem-vindos.

## Licença

MIT

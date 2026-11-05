# Minerador de CPU opcional para quem roda o HomeMinerProxy em Docker (perfil "minerador" do compose):
# o cpuminer (pooler), compilado como nas imagens do cartão SD, apontado para o proxy do próprio compose.
#   docker compose --profile minerador up -d
# Usa BTC_ADDRESS do mineracao.env; LOCAL_WORKER é o nome no painel (padrão "docker") e
# MINER_THREADS o número de núcleos (padrão: todos menos um).
FROM debian:trixie-slim AS build
ARG CPUMINER_REF=v2.5.1
RUN apt-get update && apt-get install -y --no-install-recommends build-essential automake autoconf pkg-config libcurl4-openssl-dev git ca-certificates \
 && git clone -q --depth 1 --branch "$CPUMINER_REF" https://github.com/pooler/cpuminer.git /src \
 && cd /src && ./autogen.sh >/dev/null && ./configure CFLAGS="-O3" >/dev/null && make -j"$(nproc)" >/dev/null && strip minerd

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends libcurl4t64 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/minerd /usr/local/bin/minerd
USER nobody
ENV MINER_URL=stratum+tcp://proxy:3333
# baixa prioridade: o proxy e o painel vêm primeiro
CMD ["sh", "-c", "[ -n \"$BTC_ADDRESS\" ] || { echo 'BTC_ADDRESS vazio no mineracao.env / BTC_ADDRESS is empty'; exit 1; }; n=$(nproc); t=${MINER_THREADS:-$(( n > 1 ? n - 1 : 1 ))}; exec nice -n 19 minerd -a sha256d -o \"$MINER_URL\" -u \"$BTC_ADDRESS.${LOCAL_WORKER:-docker}\" -p x -t \"$t\""]

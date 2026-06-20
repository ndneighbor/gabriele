# ---- build the release ----
FROM elixir:1.17.3-otp-27 AS build
ENV MIX_ENV=prod
WORKDIR /app
RUN mix local.hex --force && mix local.rebar --force
COPY mix.exs mix.lock ./
RUN mix deps.get --only prod
COPY config ./config
RUN mix deps.compile
COPY lib ./lib
RUN mix compile
RUN mix release

# ---- run it ----
FROM debian:bookworm-slim AS app
RUN apt-get update \
 && apt-get install -y --no-install-recommends libstdc++6 openssl libncurses6 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV HOME=/app
COPY --from=build /app/_build/prod/rel/relay ./
CMD ["bin/relay", "start"]

# Uncut's headless server for Linux, built from the repo root (pnpm server:image, pnpm server:tarball).
# Base images are pinned by digest and the lockfiles by --locked and --frozen-lockfile, so the
# tarball stage is byte-identical between builds. The image's apt packages follow Debian bookworm.

FROM rust:1-bookworm@sha256:9181b56c2a21ab1d5e73cffe04fc762426d30aa7fac3c91141dd033f49a7fc8b AS media
WORKDIR /src
COPY native/media/Cargo.toml native/media/Cargo.lock ./
COPY native/media/src ./src
RUN cargo build --release --locked

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter '!@uncut/site'
RUN pnpm --filter @uncut/server --filter @uncut/desktop build
RUN node scripts/server-package.ts /out
COPY --from=media /src/target/release/uncut-media /out/bin/uncut-media

FROM build AS archive
RUN arch="$(dpkg --print-architecture)" \
 && tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=u+rwX,go+rX,go-w \
      --transform "s,^out,uncut-server-linux-$arch," -C / -cf - out | gzip -n -9 > "/uncut-server-linux-$arch.tar.gz"

FROM scratch AS tarball
COPY --from=archive /uncut-server-linux-*.tar.gz /

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS image
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ffmpeg procps ca-certificates xvfb xauth \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 libgbm1 libasound2 \
      libxss1 libxshmfence1 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 \
 && rm -rf /var/lib/apt/lists/*
# HOME is the volume: the token, settings, projects and a claude login all outlive the container.
RUN usermod -l uncut -d /data -m -s /bin/bash node && groupmod -n uncut node
COPY --from=build /out /opt/uncut
COPY --from=build /src/node_modules/electron/dist /opt/electron
COPY scripts/remote-docker/electron-render.sh /usr/local/bin/uncut-electron-render
COPY infra/server/entrypoint.sh /usr/local/bin/uncut-entrypoint
RUN chmod 755 /opt/uncut/uncut-server /usr/local/bin/uncut-electron-render /usr/local/bin/uncut-entrypoint
ENV UNCUT_RENDER_BIN=/usr/local/bin/uncut-electron-render
USER uncut
VOLUME /data
EXPOSE 8790
ENTRYPOINT ["/usr/local/bin/uncut-entrypoint"]

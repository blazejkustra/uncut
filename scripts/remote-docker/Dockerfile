# A Linux "other machine" for scripts/remote-docker-check.ts: Debian with Node 24, sshd, ffmpeg,
# Uncut's media core built from source for linux, the bundled server, and Electron (the export's
# rasteriser) with a virtual display. The build context is a temp folder the script stages with
# the repo-relative layout the server expects in development (/opt/uncut/apps/server/dist, ...).
# The ssh login key isn't baked in: the container gets the public half at run time (AUTHORIZED_KEY).

# The media core, for this image's architecture.
FROM rust:1-bookworm AS media
WORKDIR /src
COPY native/media/Cargo.toml native/media/Cargo.lock ./
COPY native/media/src ./src
RUN cargo build --release --locked

FROM node:24-bookworm
ARG ELECTRON_VERSION=44.6.0
ARG TARGETARCH
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server ffmpeg procps unzip curl ca-certificates xvfb xauth \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 libgbm1 libasound2 \
      libxss1 libxshmfence1 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 \
 && rm -rf /var/lib/apt/lists/*
# Electron, straight from its release (no package manager in the image).
RUN arch="$([ "$TARGETARCH" = "amd64" ] && echo x64 || echo "${TARGETARCH:-arm64}")" \
 && curl -fsSL -o /tmp/electron.zip "https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-${arch}.zip" \
 && mkdir -p /opt/electron && unzip -q /tmp/electron.zip -d /opt/electron && rm /tmp/electron.zip
# sshd: keys only, one non-root user with a login shell (the server asks it for PATH).
RUN useradd -m -s /bin/bash uncut \
 && mkdir -p /run/sshd /home/uncut/.ssh && chmod 700 /home/uncut/.ssh && chown uncut:uncut /home/uncut/.ssh \
 && ssh-keygen -A \
 && printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers uncut\n' > /etc/ssh/sshd_config.d/uncut.conf
COPY --from=media /src/target/release/uncut-media /opt/uncut/native/media/target/release/uncut-media
COPY scripts/remote-docker/entrypoint.sh /usr/local/bin/uncut-entrypoint
COPY scripts/remote-docker/electron-render.sh /usr/local/bin/uncut-electron-render
RUN chmod 755 /usr/local/bin/uncut-entrypoint /usr/local/bin/uncut-electron-render
# What changes with every server build goes last.
COPY opt/uncut /opt/uncut
RUN chmod 755 /opt/uncut/test/helpers/fake-claude.ts
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/uncut-entrypoint"]

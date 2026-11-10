# syntax=docker/dockerfile:1
#
# Donna's local runtime and web app for the compose start (docker-compose.yml;
# README.md, "Run Donna locally"). One image, two services: the runtime runs
# scripts/desktop-boot.mjs and the web app runs scripts/local_web.mjs, the same
# entry points as the host-installed start. PostgreSQL runs in its own service;
# this image carries only the PostgreSQL 16 client programs the runtime's
# backups drive (pg_dump, pg_restore, psql), never a server.
#
# The image holds no key and no .env (.dockerignore). Keys come from the
# person's own .env at run time (docker-compose.yml, env_file).

# PostgreSQL 16 client programs, taken from the same pinned image the database
# service and CI run (.github/workflows/ci.yml), so client and server are one
# release. Their shared libraries come along; the final stage keeps only the
# ones its own base lacks.
FROM postgres:16.15-bookworm@sha256:bb3e1a57e5407e0a5280b4211980a5e537f4abd234a87014ac979849a78dd825 AS pgclient
RUN set -eu; \
    mkdir -p /opt/pg16/bin /opt/pg16/lib; \
    for tool in psql pg_dump pg_restore; do cp "/usr/lib/postgresql/16/bin/$tool" /opt/pg16/bin/; done; \
    ldd /opt/pg16/bin/* | awk '$3 ~ /^\// { print $3 }' | sort -u \
      | grep -Ev '/(libc|libm|libdl|libpthread|libresolv|librt)\.so|/ld-linux' \
      | xargs -r -I{} cp -L {} /opt/pg16/lib/

# Build: dependencies, the build identity Host A reads, and the web app.
FROM node:20.20.2-bookworm@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no install script is needed to run or build Donna (the
# supabase CLI download is the only one that does anything, and it is a
# hosted-setup tool).
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
# The packaged-build identity file (desktop/build-identity.json), written by
# the same script the desktop app's build uses, from this checkout's git
# state: the commit, and whether the accounting runtime differs from it. The
# final image has no .git, so the runtime reads this file. A checkout made on
# Windows with core.autocrlf=true has CRLF files that git there calls clean;
# autocrlf=input makes git here compare them the same way.
RUN GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=input \
    node scripts/write_desktop_build_identity.mjs
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf .git

FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
COPY --from=pgclient /opt/pg16 /opt/pg16
# Keep only the libraries this base does not already have, then register them.
RUN set -eu; \
    for lib in /opt/pg16/lib/*; do \
      if ldconfig -p | grep -q "^[[:space:]]$(basename "$lib") "; then rm "$lib"; fi; \
    done; \
    echo /opt/pg16/lib > /etc/ld.so.conf.d/zz-donna-pg16.conf; \
    ldconfig; \
    /opt/pg16/bin/pg_dump --version | grep -q '(PostgreSQL) 16\.'; \
    /opt/pg16/bin/psql --version | grep -q '(PostgreSQL) 16\.'; \
    mkdir /data; \
    chown node:node /data
# The application files are root's and read-only to the app user; the book
# (documents, backups) is written only under /data, a named volume.
COPY --from=build /app /app
WORKDIR /app
USER node
EXPOSE 8787 5173
CMD ["node", "scripts/desktop-boot.mjs"]

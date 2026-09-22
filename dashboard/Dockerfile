# The Operations Data Layer dashboard: the compiled React bundle served by
# nginx, which also reverse-proxies /api to the data layer next to it in the
# pod. See docs/containers.md.
#
#   docker build -t odl-dashboard:latest dashboard
#
# Behind a corporate registry, with a UBI nginx base and an npm mirror:
#
#   docker build -t odl-dashboard:latest dashboard \
#       --build-arg NODE_IMAGE=registry.example.com/node:22-alpine \
#       --build-arg NGINX_IMAGE=registry.access.redhat.com/ubi9/nginx-124 \
#       --build-arg NPM_REGISTRY=https://nexus.example.com/repository/npm/
#
# Where the build cannot reach an npm registry at all, compile on the host and
# copy the result in (DIST=prebuilt skips the node stage entirely):
#
#   (cd dashboard && npm run build)
#   docker build -t odl-dashboard:latest dashboard --build-arg DIST=prebuilt

ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:1.27-alpine
ARG DIST=build

# ---- compile the bundle in the image (DIST=build, the default) -------------
FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY
# A UBI node base starts as an unprivileged user that cannot write to /app;
# this stage is thrown away, so root here costs nothing.
USER 0
WORKDIR /app
COPY package.json package-lock.json* ./
# npm ci is reproducible but needs a lockfile; fall back to install without one.
RUN if [ -n "${NPM_REGISTRY:-}" ]; then npm config set registry "${NPM_REGISTRY}"; fi \
 && if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else npm install --no-audit --no-fund; fi
COPY . .
RUN npm run build

# ---- or take a dist/ compiled on the host (DIST=prebuilt) ------------------
# FROM scratch: this stage is a file carrier, not a runnable image.
FROM scratch AS prebuilt
COPY dist /app/dist

# DIST picks which of the two stages above supplies /app/dist. Only the one
# named is built, so DIST=prebuilt never needs the node base image.
FROM ${DIST} AS dist

# ---- runtime ---------------------------------------------------------------
FROM ${NGINX_IMAGE}

# Defaults for a pod where the API is the container next door; every one of
# them is overridable at run time (entrypoint.sh renders the server block).
ENV PORT=8080 \
    API_UPSTREAM=127.0.0.1:8000 \
    PATCHING_UPSTREAM=127.0.0.1:8010 \
    API_READ_TIMEOUT=120s \
    AGENT_READ_TIMEOUT=900s

# A UBI nginx base starts as an unprivileged user; the file layout below needs
# root at build time. The image still runs unprivileged (USER at the end).
USER 0

# Pull the base image's own security updates. The tag of a base image is a
# snapshot; the fixed OpenSSL or libc it needs may have shipped a week after
# it. Each package manager the supported bases use is tried in turn, so the
# same Dockerfile builds on Alpine, Debian and UBI.
RUN if command -v apk >/dev/null 2>&1; then apk upgrade --no-cache; \
    elif command -v microdnf >/dev/null 2>&1; then microdnf upgrade -y && microdnf clean all; \
    elif command -v dnf >/dev/null 2>&1; then dnf upgrade -y && dnf clean all; \
    elif command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*; \
    fi

COPY nginx/nginx.conf nginx/default.conf.template nginx/entrypoint.sh /etc/nginx/odl/

RUN rm -rf /usr/share/nginx/html && mkdir -p /usr/share/nginx/html
COPY --from=dist /app/dist /usr/share/nginx/html

# OpenShift's restricted-v2 SCC runs the container as an arbitrary UID in
# GID 0, so everything the process touches has to be group-readable (and the
# entrypoint group-executable) rather than owned by a particular user.
RUN chmod +x /etc/nginx/odl/entrypoint.sh \
 && chgrp -R 0 /etc/nginx/odl /usr/share/nginx/html \
 && chmod -R g=u /etc/nginx/odl /usr/share/nginx/html

# Numeric, so runAsNonRoot can be enforced without resolving a name.
USER 101:0
EXPOSE 8080
STOPSIGNAL SIGQUIT
ENTRYPOINT ["/etc/nginx/odl/entrypoint.sh"]

LABEL org.opencontainers.image.title="Operations Data Layer dashboard" \
      org.opencontainers.image.description="React dashboard served by nginx, reverse-proxying /api to the data layer" \
      org.opencontainers.image.source="https://github.com/aasthapit/Operations-Data-Layer" \
      org.opencontainers.image.licenses="Apache-2.0"

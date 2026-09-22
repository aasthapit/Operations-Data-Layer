# The backend image: one image, three roles (api, worker, all), picked at
# runtime by the entrypoint. One image rather than three because the API and
# the collector are the same code reading the same manifest against the same
# store - shipping them separately would only create two things to keep in step.
#
# Two stages so the runtime layer carries no build tooling: the builder puts a
# virtualenv in /opt/venv and the runtime copies it. PYTHON_IMAGE is a build arg
# used by BOTH stages, so the venv's interpreter symlinks resolve in the runtime
# image: python:3.12-slim by default, and a UBI base
# (registry.access.redhat.com/ubi9/python-312) where the platform requires one.
# Nothing below relies on apt, on a /usr/local path, or on a user that already
# exists - those are exactly the three things that differ between the two.
#
# The image runs unprivileged with a read-only root filesystem: UID 1001, GID 0,
# and correct under an arbitrary UID with GID 0 (OpenShift's restricted SCC
# assigns one per namespace). /tmp is the only writable path, which is why HOME
# points there.
#
# There is no HEALTHCHECK. Probes belong to the orchestrator, which is the only
# thing that knows what to do when one fails; podman ignores the instruction
# under `kube play` anyway. See deploy/ for the probes themselves.
ARG PYTHON_IMAGE=python:3.12-slim

# --------------------------------------------------------------------------- #
# builder: the virtualenv, as root
# --------------------------------------------------------------------------- #
FROM ${PYTHON_IMAGE} AS builder

# A build behind a corporate proxy resolves packages through an internal mirror.
ARG PIP_INDEX_URL=""
ARG PIP_EXTRA_INDEX_URL=""
ARG PIP_TRUSTED_HOST=""
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_EXTRA_INDEX_URL=${PIP_EXTRA_INDEX_URL} \
    PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST} \
    PIP_DISABLE_PIP_VERSION_CHECK=1

USER 0
WORKDIR /src
COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt \
    # pip is a build tool: nothing installs anything at run time, and every
    # scanner would otherwise report the venv's pip against the CVE of the month.
    && /opt/venv/bin/python -m pip uninstall -y pip \
    && rm -rf /opt/venv/lib/python3.*/site-packages/pip*

# --------------------------------------------------------------------------- #
# runtime
# --------------------------------------------------------------------------- #
FROM ${PYTHON_IMAGE} AS runtime

LABEL org.opencontainers.image.title="Operations Data Layer backend" \
      org.opencontainers.image.description="Fleet health, inventory, utilization, insights and \
blast radius over a multi-hub OpenShift estate. ODL_ROLE picks the role: api, worker or all." \
      org.opencontainers.image.source="https://github.com/aasthapit/Operations-Data-Layer" \
      org.opencontainers.image.version="0.2.0"

USER 0
# Pull the base image's own security updates. The tag of a base image is a
# snapshot; the fixed OpenSSL or libc it needs may have shipped a week after
# it. Each package manager the supported bases use is tried in turn, so the
# same Dockerfile builds on Debian and UBI.
RUN if command -v microdnf >/dev/null 2>&1; then microdnf upgrade -y && microdnf clean all; \
    elif command -v dnf >/dev/null 2>&1; then dnf upgrade -y && dnf clean all; \
    elif command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*; \
    elif command -v apk >/dev/null 2>&1; then apk upgrade --no-cache; \
    fi
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:${PATH}" \
    HOME=/tmp \
    PORT=8000 \
    ODL_ROLE=all

COPY --from=builder /opt/venv /opt/venv
# The base image's own pip goes too, for the same reason; the interpreter and
# the standard library are all the runtime needs.
RUN python3 -m pip uninstall -y pip >/dev/null 2>&1 || true \
    && find / -xdev -type d -name "pip" -path "*site-packages*" -prune -exec rm -rf {} + 2>/dev/null || true \
    && find / -xdev -type d -name "pip-*.dist-info" -path "*site-packages*" -prune -exec rm -rf {} + 2>/dev/null || true
COPY app ./app
COPY config ./config
COPY scripts ./scripts
COPY entrypoint.sh ./entrypoint.sh

# Group 0 with the owner's rights is what makes an arbitrary assigned UID work:
# it always lands in GID 0, and nothing here depends on being UID 1001.
RUN chmod +x /app/entrypoint.sh \
    && chgrp -R 0 /app \
    && chmod -R g=u /app

USER 1001:0
EXPOSE 8000
ENTRYPOINT ["/app/entrypoint.sh"]

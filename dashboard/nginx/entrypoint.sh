#!/bin/sh
# Render the dashboard's server block and start nginx in the foreground.
#
# POSIX sh, no dependency on the official nginx image's /docker-entrypoint.d
# envsubst scripts: the same image has to work on a UBI nginx base. Everything
# written here lands under /tmp, the only writable mount when the container
# runs with a read-only root filesystem.
set -eu

CONF_DIR=/etc/nginx/odl
TMP_DIR=/tmp/nginx

PORT="${PORT:-8080}"
API_UPSTREAM="${API_UPSTREAM:-127.0.0.1:8000}"
# An IP literal by default: a hostname that does not resolve is a fatal nginx
# start error, and most deployments have no patching service at all.
PATCHING_UPSTREAM="${PATCHING_UPSTREAM:-127.0.0.1:8010}"
API_READ_TIMEOUT="${API_READ_TIMEOUT:-120s}"
# An agent run against a local model takes up to ten minutes.
AGENT_READ_TIMEOUT="${AGENT_READ_TIMEOUT:-900s}"

mkdir -p \
    "${TMP_DIR}/conf.d" \
    "${TMP_DIR}/client_body" \
    "${TMP_DIR}/proxy" \
    "${TMP_DIR}/fastcgi" \
    "${TMP_DIR}/uwsgi" \
    "${TMP_DIR}/scgi"

# Exactly the five known placeholders. sed, not envsubst: envsubst would also
# eat nginx's own $host / $uri / $remote_addr, and it is not on every base.
sed \
    -e "s|\${PORT}|${PORT}|g" \
    -e "s|\${API_UPSTREAM}|${API_UPSTREAM}|g" \
    -e "s|\${PATCHING_UPSTREAM}|${PATCHING_UPSTREAM}|g" \
    -e "s|\${API_READ_TIMEOUT}|${API_READ_TIMEOUT}|g" \
    -e "s|\${AGENT_READ_TIMEOUT}|${AGENT_READ_TIMEOUT}|g" \
    "${CONF_DIR}/default.conf.template" > "${TMP_DIR}/conf.d/default.conf"

echo "odl-dashboard: listening on ${PORT}, api ${API_UPSTREAM}, patching ${PATCHING_UPSTREAM}" >&2

# Fail loudly on a bad substitution or an unresolvable upstream rather than
# crash-looping with nginx's own terse message.
nginx -t -c "${CONF_DIR}/nginx.conf"

exec nginx -c "${CONF_DIR}/nginx.conf" -g 'daemon off;'

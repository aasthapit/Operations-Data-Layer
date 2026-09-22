# The MCP server wrapping the data layer's REST API.
#
# The image runs unprivileged: UID 1001 in GID 0, the same shape the backend
# and dashboard images use, so it is correct under an arbitrary assigned UID
# (OpenShift's restricted SCC picks one per namespace) and under a read-only
# root filesystem. Nothing here writes outside /tmp.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
# Group 0 with the owner's rights is what makes an arbitrary assigned UID work.
RUN chgrp -R 0 /app && chmod -R g=u /app
# Default to an HTTP transport when containerized; override MCP_TRANSPORT=stdio
# to run as a stdio server via `docker run -i`.
#
# MCP_HOST is 0.0.0.0 because a container's published port is reached on its
# own interface, not on loopback. server.py still defaults to 127.0.0.1, so a
# server run straight from a checkout stays local.
ENV MCP_TRANSPORT=streamable-http MCP_API_BASE=http://api:8000 \
    MCP_HOST=0.0.0.0 MCP_PORT=8000
USER 1001:0
EXPOSE 8000
CMD ["python", "server.py"]

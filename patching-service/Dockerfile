# The patching system of record.
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
COPY app ./app
# Group 0 with the owner's rights is what makes an arbitrary assigned UID work.
RUN chgrp -R 0 /app && chmod -R g=u /app
USER 1001:0
EXPOSE 8000
# 0.0.0.0 because a container's published port is reached on its own
# interface, not on loopback.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

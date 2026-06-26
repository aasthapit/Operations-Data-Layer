FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
# Default to an HTTP transport when containerized; override MCP_TRANSPORT=stdio
# to run as a stdio server via `docker run -i`.
ENV MCP_TRANSPORT=streamable-http MCP_API_BASE=http://api:8000 \
    MCP_HOST=0.0.0.0 MCP_PORT=8000
EXPOSE 8000
CMD ["python", "server.py"]

# Python 3.12 with numpy/pandas/matplotlib/scipy/sympy, plus the Node 22 runtime copied in.
FROM node:22-bookworm-slim AS node
FROM python:3.12-slim
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN pip install --no-cache-dir numpy pandas matplotlib scipy sympy \
 && useradd --create-home --uid 1000 runner
WORKDIR /srv
COPY server.mjs .
USER runner
EXPOSE 8080
CMD ["node", "server.mjs"]

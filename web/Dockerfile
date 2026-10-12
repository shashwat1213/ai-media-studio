# syntax=docker/dockerfile:1.7
#
# Web image: build the static SPA with Vite, then serve it with nginx. Spec: specs/05_dockerize_spec.md
#
# Why nginx and not `vite preview` / a Node server? After `vite build` the app is just static
# files. nginx serves static files extremely efficiently, handles gzip + caching headers, and the
# final image contains no Node.js, no node_modules, no source code: ~10x smaller attack surface.

ARG NODE_IMAGE=node:22.23.3-alpine3.24
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.31.6-alpine3.24

# ---------- build ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
# Baked in at BUILD time (Vite inlines import.meta.env). '/api' = same origin, proxied by nginx
# to the api container, so this ONE image works in any environment: no rebuild per URL.
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

# ---------- runtime ----------
# nginx-unprivileged: runs as a non-root user (uid 101) and listens on 8080 instead of 80
# (binding ports < 1024 needs root).
FROM ${NGINX_IMAGE} AS runtime
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
# Where nginx forwards /api/*. Overridable at RUN time (envsubst renders the template on start).
ENV API_UPSTREAM=http://api:4000
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

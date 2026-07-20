# Tessera web client.
#
# The output is static files. They are built once here and served by nginx -
# there is no Node process in the final image at all, which is why it is a few
# megabytes rather than a few hundred.

FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/

RUN npm ci --ignore-scripts

COPY packages/core ./packages/core
COPY packages/web ./packages/web

RUN npm run build -w @tessera/core && npm run build -w @tessera/web

FROM nginx:1.27-alpine AS runtime

COPY --from=builder /app/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

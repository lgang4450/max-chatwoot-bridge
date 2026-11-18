FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY certs ./certs
RUN sha256sum -c certs/SHA256SUMS && cp certs/*.crt /usr/local/share/ca-certificates/ && update-ca-certificates
ENV NODE_ENV=production NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE UPSTREAM.md ./
USER node
EXPOSE 3000
CMD ["node","dist/index.js"]

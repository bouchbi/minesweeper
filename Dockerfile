# Version mineure fixée : `node:sqlite` exige Node ≥ 22.13, et un tag flottant
# (`22-alpine`) peut être servi depuis un vieux cache par Coolify.
# ── Build : client (Vite) + serveur (esbuild) ─────────────────────────────
FROM node:22.23-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:all

# ── Runtime : seul `ws` reste externe au bundle serveur ───────────────────
FROM node:22.23-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
# Parties sauvegardées et records (SQLite). À monter sur un volume persistant
# dans Coolify (Storages), sinon tout repart à zéro à chaque redéploiement.
RUN mkdir -p /app/data && chown node:node /app/data
EXPOSE 8080
USER node
CMD ["node", "dist-server/main.mjs", "dist"]

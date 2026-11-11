FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=UTC ORBOX_DOCKER=1 DATA_DIR=/app/data
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/web/dist web/dist
# /app/data 保存安装向导写入的配置（数据库连接、密钥），需要挂载卷
RUN mkdir -p /app/logs /app/data && chown node:node /app/logs /app/data
USER node
EXPOSE 8787
CMD ["node", "server/dist/index.js"]

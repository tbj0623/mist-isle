FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client ./client
COPY shared ./shared
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY shared ./shared
COPY server ./server
# 对局结果落盘目录（MATCH_LOG_PATH 默认 /app/data/matches.jsonl）：挂载卷持久化
RUN mkdir -p /app/data && chown -R node:node /app/data
# 原生 TLS/WSS（可选）：-v 证书目录 + -e TLS_CERT=... -e TLS_KEY=...（两者必须同时设置）
#
# 健康检查必须跟着 TLS 走：设了 TLS_CERT 时服务以 node:https 监听，
# 硬编码 http:// 会让握手失败 → 容器永远 unhealthy（哪怕对局一切正常）。
# 证书多半是自签/内网 CA，https 分支关闭证书校验（只探活，不验身份）。
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "const s=process.env.TLS_CERT?'https':'http';const o=s==='https'?{rejectUnauthorized:false}:undefined;fetch(s+'://127.0.0.1:'+(process.env.PORT||8787)+'/health',o).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]

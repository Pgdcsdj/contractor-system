# Node.js 后端构建（纯后端镜像，前端由宿主机 dist bind-mount 提供）
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

FROM node:20-alpine AS production
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S nodeapp -u 1001
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src ./src
# 答题明细 PDF 导出所需中文字体（Noto Sans CJK SC 子集，约 6.8MB）
COPY --from=builder /app/assets/fonts ./assets/fonts
USER nodeapp
EXPOSE 3000
ENV NODE_ENV=production PORT=3000 TZ=Asia/Shanghai
CMD ["node", "src/server.js"]

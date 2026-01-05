# ============================================
# AntiHub Plugin - Docker Image
# ============================================
# 这是一个纯 JavaScript 项目，无需构建步骤
# 使用多阶段构建优化镜像大小
# ============================================

# ----- 阶段 1: 依赖安装 -----
FROM node:20-alpine AS deps

WORKDIR /app

# 先复制锁文件，利用 Docker 层缓存
COPY package.json package-lock.json* ./

# 只安装生产环境依赖
RUN npm ci --only=production

# 安装 PostgreSQL 客户端（用于自动初始化数据库）
RUN apk add --no-cache postgresql-client

# ----- 阶段 2: 生产镜像 -----
FROM node:20-alpine AS production

# 安装 PostgreSQL 客户端（用于自动初始化数据库）
RUN apk add --no-cache postgresql-client

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=8045

# 创建非 root 用户运行应用（安全最佳实践）
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# 从依赖阶段复制 node_modules
COPY --from=deps /app/node_modules ./node_modules

# 复制应用源码
COPY package.json ./
COPY src ./src
COPY schema.sql ./
COPY scripts ./scripts

# 创建 config.json 模板（运行时需要替换）
# 默认配置为空，用户需要通过环境变量或挂载配置文件
ENV CONFIG_TEMPLATE='{"server":{"port":8045,"host":"0.0.0.0"},"database":{"host":"${DB_HOST}","port":5432,"database":"${DB_NAME}","user":"${DB_USER}","password":"${DB_PASSWORD}"},"redis":{"host":"${REDIS_HOST}","port":6379,"password":"${REDIS_PASSWORD}"},"oauth":{"callbackUrl":"${OAUTH_CALLBACK_URL}"},"security":{"adminApiKey":"${ADMIN_API_KEY}"}}'

# 复制入口脚本并添加执行权限
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 修改文件所有者
RUN chown -R appuser:appgroup /app

# 切换到非 root 用户
USER appuser

# 暴露端口
EXPOSE 8045

# 启动命令（使用 entrypoint 脚本生成配置）
ENTRYPOINT ["/entrypoint.sh"]

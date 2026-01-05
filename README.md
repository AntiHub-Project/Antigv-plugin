# 反重力 to OpenAI API 代理服务

一个功能强大的 反重力 API 转 OpenAI 兼容格式的代理服务，支持多用户管理、OAuth认证、配额管理、流式响应、工具调用和多账号轮换。

## 📝 声明

本项目基于 [liuw1535](https://github.com/liuw1535) 的 [antigravity2api-nodejs](https://github.com/liuw1535/antigravity2api-nodejs) 进行开发和扩展。感谢原作者的开源贡献！

## ✨ 功能特性

- 🔄 **OpenAI API 兼容格式** - 完全兼容 OpenAI API v1 接口
- 🌊 **流式和非流式响应** - 支持 SSE 流式输出和传统响应
- 🛠️ **工具调用支持** - 完整支持 Function Calling 功能
- 👥 **多用户管理** - 支持多用户隔离，每个用户独立的 API Key
- 🔄 **多账号自动轮换** - 智能账号切换，提高服务可用性
- 🔐 **OAuth 认证** - 基于 Google OAuth 的安全认证
- 🔄 **Token 自动刷新** - 自动处理 Token 过期和刷新
- 📊 **配额管理系统** - 精确的配额监控和自动恢复机制
- 🖼️ **图片输入支持** - 支持 Base64 编码的多模态输入
- 🧠 **思维链输出** - 支持 AI 思考过程输出
- 📈 **使用统计** - 详细的配额消耗和使用记录

## 🚀 快速开始

### 环境要求

- Node.js >= 18.0.0
- PostgreSQL >= 12

### 1. 安装依赖

```bash
npm install
```

### 2. 配置数据库

复制配置文件模板并替换为你自己的实际数据：

```bash
cp config.json.example config.json
```

### 3. 初始化数据库

创建数据库和表结构：

```bash
# 创建数据库
createdb antigv

# 导入表结构
psql -U postgres -d antigv -f schema.sql
```

### 4. 启动服务

```bash
npm start
```

服务将在 `http://0.0.0.0:8045` 启动。

### 5. 创建第一个用户

使用管理员 API Key 创建用户：

```bash
curl -X POST http://localhost:8045/api/users \
  -H "Authorization: Bearer sk-admin-your-secret-key-here" \
  -H "Content-Type: application/json" \
  -d '{"name": "测试用户"}'
```

响应会返回用户的 API Key，用于后续操作。

## 📖 API 使用

### 获取模型列表

```bash
curl http://localhost:8045/v1/models \
  -H "Authorization: Bearer sk-user-api-key"
```

### 聊天补全（流式）

```bash
curl http://localhost:8045/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-user-api-key" \
  -d '{
    "model": "gemini-3-pro-high",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### 聊天补全（非流式）

```bash
curl http://localhost:8045/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-user-api-key" \
  -d '{
    "model": "gemini-3-pro-high",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

### 工具调用示例

```bash
curl http://localhost:8045/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-user-api-key" \
  -d '{
    "model": "gemini-3-pro-high",
    "messages": [{"role": "user", "content": "北京天气怎么样"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "获取天气信息",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {"type": "string", "description": "城市名称"}
          }
        }
      }
    }]
  }'
```

### 图片输入示例

支持 Base64 编码的图片输入：

```bash
curl http://localhost:8045/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-user-api-key" \
  -d '{
    "model": "gemini-3-pro-high",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "这张图片里有什么？"},
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
          }
        }
      ]
    }],
    "stream": true
  }'
```

支持的图片格式：
- JPEG/JPG (`data:image/jpeg;base64,...`)
- PNG (`data:image/png;base64,...`)
- GIF (`data:image/gif;base64,...`)
- WebP (`data:image/webp;base64,...`)

## 🔐 账号管理

### 添加 Google 账号

1. 获取 OAuth 授权 URL：

```bash
curl -X POST http://localhost:8045/api/oauth/authorize \
  -H "Authorization: Bearer sk-user-api-key" \
  -H "Content-Type: application/json" \
  -d '{"is_shared": 0}'
```

2. 在浏览器中打开返回的 `auth_url` 进行授权
3. 授权成功后会自动回调保存账号信息

### 查看账号列表

```bash
curl http://localhost:8045/api/accounts \
  -H "Authorization: Bearer sk-user-api-key"
```

## 📊 配额管理

### 查看用户配额

```bash
curl http://localhost:8045/api/quotas/user \
  -H "Authorization: Bearer sk-user-api-key"
```

### 查看配额消耗记录

```bash
curl "http://localhost:8045/api/quotas/consumption?limit=100" \
  -H "Authorization: Bearer sk-user-api-key"
```

### 配额机制说明

- **专属账号** (`is_shared=0`): 不消耗配额池，仅作记录
- **共享账号** (`is_shared=1`): 消耗用户共享配额池
- **配额上限**: 2 × 用户共享账号数量
- **自动恢复**: 每小时恢复 2n × 0.2 (n为共享账号数)

## ⚙️ 配置说明

### config.json 完整配置

```json
{
  "server": {
    "port": 8045,
    "host": "0.0.0.0"
  },
  "oauth": {
    "callbackUrl": "https://your-domain.com/api/oauth/callback"
  },
  "database": {
    "host": "localhost",
    "port": 5432,
    "database": "反重力",
    "user": "postgres",
    "password": "your_password",
    "max": 20,
    "idleTimeoutMillis": 30000,
    "connectionTimeoutMillis": 2000
  },
  "api": {
    "url": "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    "modelsUrl": "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
    "host": "daily-cloudcode-pa.sandbox.googleapis.com",
    "userAgent": "反重力/1.11.3 windows/amd64"
  },
  "defaults": {
    "temperature": 1,
    "top_p": 0.85,
    "top_k": 50,
    "max_tokens": 8096
  },
  "security": {
    "maxRequestSize": "50mb",
    "adminApiKey": "sk-admin-your-secret-key-here"
  },
  "systemInstruction": ""
}
```

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `server.port` | 服务端口 | 8045 |
| `server.host` | 监听地址 | 0.0.0.0 |
| `oauth.callbackUrl` | OAuth 回调地址 | - |
| `database.*` | 数据库连接配置 | - |
| `security.adminApiKey` | 管理员 API Key | - |
| `security.maxRequestSize` | 最大请求体大小 | 50mb |
| `defaults.temperature` | 默认温度参数 | 1 |
| `defaults.top_p` | 默认 top_p | 0.85 |
| `defaults.top_k` | 默认 top_k | 50 |
| `defaults.max_tokens` | 默认最大 token 数 | 8096 |

## 🛠️ 开发命令

```bash
# 启动服务
npm start

# 开发模式（自动重启）
npm run dev

# 手动执行配额恢复任务
node scripts/quota-recovery-cron.js
```

## 📁 项目结构

```
.
├── data/                      # 数据存储目录（自动生成）
│   └── accounts.json          # Token 存储（旧版本）
├── scripts/                   # 脚本目录
│   ├── oauth-server.js        # OAuth 登录服务
│   └── quota-recovery-cron.js # 配额恢复定时任务
├── src/                       # 源代码目录
│   ├── api/                   # API 调用逻辑
│   │   ├── client.js          # 单账号客户端
│   │   └── multi_account_client.js # 多账号客户端
│   ├── auth/                  # 认证模块
│   │   └── token_manager.js   # Token 管理
│   ├── config/                # 配置模块
│   │   └── config.js          # 配置加载
│   ├── db/                    # 数据库模块
│   │   └── database.js        # 数据库连接
│   ├── server/                # 服务器模块
│   │   ├── index.js           # 主服务器
│   │   └── routes.js          # 路由定义
│   ├── services/              # 业务服务
│   │   ├── account.service.js # 账号服务
│   │   ├── oauth.service.js   # OAuth 服务
│   │   ├── quota.service.js   # 配额服务
│   │   └── user.service.js    # 用户服务
│   └── utils/                 # 工具模块
│       ├── logger.js          # 日志模块
│       └── utils.js           # 工具函数
├── test/                      # 测试目录
│   ├── debug-request.js       # 调试脚本
│   └── test-transform.js      # 测试脚本
├── config.json                # 配置文件
├── config.json.example        # 配置文件模板
├── package.json               # 项目配置
├── API.md                     # 详细 API 文档
└── README.md                  # 项目说明
```

## 🔧 工作流程

### 用户和账号管理流程

1. **管理员创建用户** - 使用管理员 API Key 创建用户，获取用户 API Key
2. **用户添加账号** - 用户使用自己的 API Key 通过 OAuth 添加 Google 账号
3. **账号自动管理** - 系统自动处理 Token 刷新和账号轮换
4. **配额监控** - 实时监控配额使用，自动恢复和预警

### 聊天请求处理流程

1. **认证验证** - 验证用户 API Key
2. **账号选择** - 根据用户和模型选择可用账号（优先专属账号）
3. **配额检查** - 检查账号配额是否充足
4. **Token 管理** - 自动刷新过期 Token
5. **API 调用** - 调用 反重力 API
6. **响应转换** - 转换为 OpenAI 兼容格式
7. **配额更新** - 更新配额使用记录

## ⚠️ 注意事项

1. **安全配置**
   - `config.json` 包含敏感信息，请勿泄露
   - 管理员 API Key 仅用于管理操作
   - 生产环境请使用强密码和 HTTPS

2. **配额管理**
   - 共享账号会消耗配额池，专属账号不会
   - 配额每小时自动恢复一次
   - 建议定期监控配额使用情况

3. **账号维护**
   - Token 会自动刷新，无需手动维护
   - 刷新失败的账号会自动禁用
   - 建议为每个用户配置多个备用账号

4. **性能优化**
   - 支持多账号并发请求
   - 自动负载均衡和故障转移
   - 建议根据使用量调整数据库连接池大小

## 🐳 Docker 部署

### 使用 Docker Compose（推荐）

```bash
# 1. 复制环境变量模板
cp env.example .env

# 2. 修改环境变量配置
vim .env

# 3. 启动服务（PostgreSQL 会自动启动，Redis 连接外部实例）
docker-compose up -d postgres app

# 4. 查看日志
docker-compose logs -f app
```

### 生产环境部署

生产环境建议使用现有的 PostgreSQL 和 Redis 实例：

```bash
# 1. 构建镜像
docker build -t anticloud-api .

# 2. 运行容器（连接现有的数据库和 Redis）
docker run -d \
  --name anticloud-api \
  -p 8045:8045 \
  -e DB_HOST=your-postgres-host \
  -e DB_PORT=5432 \
  -e DB_NAME=antigv \
  -e DB_USER=postgres \
  -e DB_PASSWORD=your-password \
  -e REDIS_HOST=your-redis-host \
  -e REDIS_PORT=6379 \
  -e REDIS_PASSWORD=your-redis-password \
  -e OAUTH_CALLBACK_URL=https://your-domain.com/api/oauth/callback \
  -e ADMIN_API_KEY=sk-admin-your-secret-key \
  anticloud-api
```

### 环境变量说明

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PORT` | 服务端口 | 8045 |
| `DB_HOST` | PostgreSQL 主机 | - |
| `DB_PORT` | PostgreSQL 端口 | 5432 |
| `DB_NAME` | 数据库名称 | - |
| `DB_USER` | 数据库用户名 | - |
| `DB_PASSWORD` | 数据库密码 | - |
| `REDIS_HOST` | Redis 主机 | localhost |
| `REDIS_PORT` | Redis 端口 | 6379 |
| `REDIS_PASSWORD` | Redis 密码 | - |
| `OAUTH_CALLBACK_URL` | OAuth 回调地址 | - |
| `ADMIN_API_KEY` | 管理员 API Key | - |

### 多项目共用 Redis

本项目的 Redis 仅用于存储 Kiro OAuth 状态（临时数据，10分钟过期），可以安全地与前端、后端等其他项目共用同一个 Redis 实例。

每个项目使用不同的 key prefix，互不干扰：
- **AntiHub-plugin**: `kiro:oauth:state:*`
- 其他项目: 使用各自的 prefix

### 自定义配置文件

可以挂载自定义 `config.json` 配置文件：

```bash
docker run -d \
  --name anticloud-api \
  -p 8045:8045 \
  -v ./config.json:/app/config.json:ro \
  anticloud-api
```

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request 来改进这个项目。

## 📞 支持

如果遇到问题，请查看 [API.md](API.md) 获取详细的 API 文档，或提交 Issue 获取帮助。

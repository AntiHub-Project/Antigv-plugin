import express from 'express';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import database from '../db/database.js';
import redisService from '../services/redis.service.js';
import routes from './routes.js';
import kiroRoutes from './kiro_routes.js';

// 设置日志级别
if (config.logging?.level) {
  logger.setLogLevel(config.logging.level);
  logger.info(`日志级别设置为: ${config.logging.level}`);
}

const app = express();

// 初始化数据库
database.initialize(config.database);

// 检查数据库连接
database.ping().then(connected => {
  if (connected) {
    logger.info('数据库连接成功');
  } else {
    logger.error('数据库连接失败，请检查配置');
  }
});

// 初始化Redis（用于Kiro OAuth状态存储）
redisService.init().then(() => {
  logger.info('Redis初始化成功');
}).catch(err => {
  logger.warn('Redis初始化失败，Kiro OAuth功能将不可用:', err.message);
});

app.use(express.json({ limit: config.security.maxRequestSize }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `请求体过大，最大支持 ${config.security.maxRequestSize}` });
  }
  next(err);
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.request(req.method, req.path, res.statusCode, Date.now() - start);
  });
  next();
});

// 使用路由（认证在routes.js中处理）
app.use(routes);
app.use(kiroRoutes);

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`服务器已启动: ${config.server.host}:${config.server.port}`);
});

// 设置服务器超时时间为10分钟（默认通常是2分钟）
// 这对于流式响应和长任务非常重要
server.setTimeout(600000);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    logger.error(`端口 ${config.server.port} 无权限访问`);
    process.exit(1);
  } else {
    logger.error('服务器启动失败:', error.message);
    process.exit(1);
  }
});

const shutdown = async () => {
  logger.info('正在关闭服务器...');
  server.close(async () => {
    await database.close();
    await redisService.close();
    logger.info('服务器已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

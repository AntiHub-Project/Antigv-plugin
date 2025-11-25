#!/usr/bin/env node

/**
 * 配额池自动恢复定时任务
 * 每小时执行一次，恢复用户共享配额池
 * 恢复量：每小时每模型 2n * 0.2，n为用户有效的共享cookie数
 * 
 * 使用方式：
 * 1. 单次执行：node scripts/quota-recovery-cron.js
 * 2. 添加到 crontab：0 * * * * /usr/bin/node /path/to/scripts/quota-recovery-cron.js
 */

import quotaService from '../src/services/quota.service.js';
import logger from '../src/utils/logger.js';
import database from '../src/db/database.js';
import config from '../src/config/config.js';

async function runQuotaRecovery() {
  try {
    // 初始化数据库连接
    if (config.database) {
      database.initialize(config.database);
      logger.info('数据库连接已初始化');
    } else {
      throw new Error('配置文件中缺少数据库配置');
    }
    
    logger.info('开始执行配额池自动恢复任务...');
    
    const recoveredCount = await quotaService.recoverAllUserSharedQuotas();
    
    logger.info(`配额池自动恢复任务完成！恢复了 ${recoveredCount} 条记录`);
    
    // 关闭数据库连接
    await database.close();
    
    process.exit(0);
  } catch (error) {
    logger.error('配额池自动恢复任务失败:', error);
    
    // 关闭数据库连接
    try {
      await database.close();
    } catch (closeError) {
      logger.error('关闭数据库连接失败:', closeError);
    }
    
    process.exit(1);
  }
}

// 执行任务
runQuotaRecovery();
import database from '../src/db/database.js';
import logger from '../src/utils/logger.js';
import projectService from '../src/services/project.service.js';
import oauthService from '../src/services/oauth.service.js';
import accountService from '../src/services/account.service.js';
import fs from 'fs';

// 读取配置文件
let dbConfig;
try {
  const configFile = fs.readFileSync('./config.json', 'utf8');
  const config = JSON.parse(configFile);
  dbConfig = config.database;
} catch (error) {
  logger.error('读取配置文件失败:', error.message);
  process.exit(1);
}

/**
 * 为所有账号生成项目ID
 * project_id_0: 从API获取
 */
async function generateProjectIdsForAllAccounts() {
  try {
    // 初始化数据库连接
    database.initialize(dbConfig);
    logger.info('数据库连接已初始化');
    
    logger.info('开始为所有账号生成项目ID...');
    
    // 获取所有账号
    const result = await database.query(
      'SELECT cookie_id, access_token, refresh_token, expires_at, project_id_0 FROM accounts ORDER BY created_at ASC'
    );
    
    const accounts = result.rows;
    logger.info(`找到 ${accounts.length} 个账号`);
    
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    
    for (const account of accounts) {
      logger.info(`\n处理账号: ${account.cookie_id}`);
      
      try {
        // 检查token是否过期
        let accessToken = account.access_token;
        if (accountService.isTokenExpired(account)) {
          logger.info(`  账号token已过期，正在刷新...`);
          try {
            const tokenData = await oauthService.refreshAccessToken(account.refresh_token);
            const expires_at = Date.now() + (tokenData.expires_in * 1000);
            await accountService.updateAccountToken(account.cookie_id, tokenData.access_token, expires_at);
            accessToken = tokenData.access_token;
            logger.info(`  ✓ Token刷新成功`);
          } catch (refreshError) {
            logger.error(`  ✗ Token刷新失败: ${refreshError.message}`);
            if (refreshError.isInvalidGrant) {
              logger.error(`  账号需要重新授权，已禁用`);
              await accountService.updateAccountStatus(account.cookie_id, 0);
            }
            failedCount++;
            continue;
          }
        }
        
        // 调用projectService更新项目ID
        logger.info(`  正在从API获取项目ID...`);
        const updatedAccount = await projectService.updateAccountProjectIds(
          account.cookie_id,
          accessToken
        );
        
        logger.info(`  ✓ 项目ID已更新:`);
        logger.info(`    project_id_0: ${updatedAccount.project_id_0 || '(空)'}`);
        logger.info(`    is_restricted: ${updatedAccount.is_restricted}`);
        logger.info(`    paid_tier: ${updatedAccount.paid_tier === true ? '付费' : updatedAccount.paid_tier === false ? '免费' : '未知'}`);
        logger.info(`    paidTier: ${JSON.stringify(updatedAccount.paidTier || null)}`);
        logger.info(`    当前状态: ${updatedAccount.status === 1 ? '启用' : '禁用'}`);
        
        // 判断账号是否应该可用
        // paidTier是对象而非数组，检查其id字段
        const hasFree = updatedAccount.paidTier &&
                       (updatedAccount.paidTier.id === 'free' ||
                        updatedAccount.paidTier.id === 'free-tier');
        
        // 账号可用条件：
        // 1. project_id_0 不为空
        // 2. project_id_0 为空但 paidTier 不含 "free"
        const shouldBeEnabled = updatedAccount.project_id_0 || !hasFree;
        
        if (shouldBeEnabled) {
          // 账号应该可用
          if (updatedAccount.status === 0) {
            // 如果当前是禁用状态，启用它
            logger.info(`  ℹ 账号符合可用条件，正在启用...`);
            await accountService.updateAccountStatus(account.cookie_id, 1);
            logger.info(`  ✓ 账号已启用`);
          } else {
            logger.info(`  ℹ 账号符合可用条件且已启用`);
          }
        } else {
          // 账号应该禁用（project_id_0为空且paidTier包含free）
          if (updatedAccount.status === 1) {
            // 如果当前是启用状态，禁用它
            logger.warn(`  ⚠ project_id_0为空且paidTier包含free，正在禁用账号...`);
            await accountService.updateAccountStatus(account.cookie_id, 0);
            logger.info(`  ✓ 账号已禁用`);
          } else {
            logger.info(`  ℹ 账号不符合可用条件且已禁用`);
          }
        }
        
        successCount++;
        
      } catch (error) {
        logger.error(`  ✗ 处理失败: ${error.message}`);
        failedCount++;
      }
    }
    
    logger.info('\n========== 生成完成 ==========');
    logger.info(`总账号数: ${accounts.length}`);
    logger.info(`成功: ${successCount}`);
    logger.info(`失败: ${failedCount}`);
    logger.info(`跳过: ${skippedCount}`);
    logger.info('==============================\n');
    
    // 显示更新后的账号信息
    const updatedResult = await database.query(
      'SELECT cookie_id, project_id_0, is_restricted FROM accounts WHERE status = 1 ORDER BY created_at ASC'
    );
    
    logger.info('所有账号的项目ID:');
    for (const account of updatedResult.rows) {
      logger.info(`\n  ${account.cookie_id}:`);
      logger.info(`    project_id_0: ${account.project_id_0 || '(空)'}`);
      logger.info(`    is_restricted: ${account.is_restricted}`);
    }
    
  } catch (error) {
    logger.error('生成项目ID失败:', error.message);
    throw error;
  } finally {
    // 关闭数据库连接
    await database.close();
  }
}

// 运行脚本
generateProjectIdsForAllAccounts()
  .then(() => {
    logger.info('\n脚本执行成功');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('\n脚本执行失败:', error);
    process.exit(1);
  });
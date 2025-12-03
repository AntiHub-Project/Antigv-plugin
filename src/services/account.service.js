import database from '../db/database.js';
import logger from '../utils/logger.js';

class AccountService {
  /**
   * 创建账号
   * @param {Object} accountData - 账号数据
   * @param {string} accountData.cookie_id - Cookie ID
   * @param {string} accountData.user_id - 用户ID
   * @param {number} accountData.is_shared - 是否共享 (0=专属, 1=共享)
   * @param {string} accountData.access_token - 访问令牌
   * @param {string} accountData.refresh_token - 刷新令牌
   * @param {number} accountData.expires_at - 过期时间戳（毫秒）
   * @returns {Promise<Object>} 创建的账号信息
   */
  async createAccount(accountData) {
    const {
      cookie_id,
      user_id,
      is_shared = 0,
      access_token,
      refresh_token,
      expires_at,
      project_id_0 = '',
      is_restricted = false,
      ineligible = false,
      name = null,
      paid_tier = null
    } = accountData;

    try {
      const result = await database.query(
        `INSERT INTO accounts (cookie_id, user_id, is_shared, access_token, refresh_token, expires_at, status, project_id_0, is_restricted, ineligible, name, paid_tier)
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11)
         RETURNING *`,
        [cookie_id, user_id, is_shared, access_token, refresh_token, expires_at, project_id_0, is_restricted, ineligible, name, paid_tier]
      );

      logger.info(`账号创建成功: cookie_id=${cookie_id}, user_id=${user_id}, name=${name || '(未设置)'}, paid_tier=${paid_tier}`);
      return result.rows[0];
    } catch (error) {
      logger.error('创建账号失败:', error.message);
      throw error;
    }
  }

  /**
   * 根据cookie_id获取账号
   * @param {string} cookie_id - Cookie ID
   * @returns {Promise<Object|null>} 账号信息
   */
  async getAccountByCookieId(cookie_id) {
    try {
      const result = await database.query(
        'SELECT * FROM accounts WHERE cookie_id = $1',
        [cookie_id]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('查询账号失败:', error.message);
      throw error;
    }
  }

  /**
   * 根据用户ID获取账号列表
   * @param {string} user_id - 用户ID
   * @returns {Promise<Array>} 账号列表（包含最后使用时间）
   */
  async getAccountsByUserId(user_id) {
    try {
      const result = await database.query(
        `SELECT a.*,
                MAX(qcl.consumed_at) as last_used_at
         FROM accounts a
         LEFT JOIN quota_consumption_log qcl ON a.cookie_id = qcl.cookie_id
         WHERE a.user_id = $1
         GROUP BY a.cookie_id
         ORDER BY a.created_at DESC`,
        [user_id]
      );
      return result.rows;
    } catch (error) {
      logger.error('查询用户账号列表失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取可用的账号（用于轮询）
   * @param {string} user_id - 用户ID（可选，如果提供则只返回该用户的专属账号；如果为null且is_shared=1，返回所有共享账号）
   * @param {number} is_shared - 是否共享（可选，0=专属, 1=共享）
   * @returns {Promise<Array>} 可用账号列表
   */
  async getAvailableAccounts(user_id = null, is_shared = null) {
    try {
      let query = 'SELECT * FROM accounts WHERE status = 1 AND need_refresh = FALSE';
      const params = [];
      let paramIndex = 1;

      // 如果指定了is_shared，添加is_shared条件
      if (is_shared !== null) {
        query += ` AND is_shared = $${paramIndex}`;
        params.push(is_shared);
        paramIndex++;
      }

      // 如果指定了user_id且不是获取共享账号（is_shared !== 1），添加user_id条件
      // 共享账号（is_shared=1）应该对所有用户可用，所以不限制user_id
      if (user_id !== null && is_shared !== 1) {
        query += ` AND user_id = $${paramIndex}`;
        params.push(user_id);
        paramIndex++;
      }

      query += ' ORDER BY created_at ASC';

      logger.info(`查询可用账号 - user_id=${user_id}, is_shared=${is_shared}, query=${query}`);

      const result = await database.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error('查询可用账号失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新账号token
   * @param {string} cookie_id - Cookie ID
   * @param {string} access_token - 新的访问令牌
   * @param {number} expires_at - 新的过期时间戳
   * @returns {Promise<Object>} 更新后的账号信息
   */
  async updateAccountToken(cookie_id, access_token, expires_at) {
    try {
      const result = await database.query(
        `UPDATE accounts 
         SET access_token = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP
         WHERE cookie_id = $3
         RETURNING *`,
        [access_token, expires_at, cookie_id]
      );

      if (result.rows.length === 0) {
        throw new Error(`账号不存在: cookie_id=${cookie_id}`);
      }

      logger.info(`账号token已更新: cookie_id=${cookie_id}`);
      return result.rows[0];
    } catch (error) {
      logger.error('更新账号token失败:', error.message);
      throw error;
    }
  }

  /**
   * 标记账号需要重新刷新token（禁用账号并设置need_refresh=true）
   * @param {string} cookie_id - Cookie ID
   * @returns {Promise<Object>} 更新后的账号信息
   */
  async markAccountNeedRefresh(cookie_id) {
    try {
      const result = await database.query(
        `UPDATE accounts
         SET status = 0, need_refresh = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE cookie_id = $1
         RETURNING *`,
        [cookie_id]
      );

      if (result.rows.length === 0) {
        throw new Error(`账号不存在: cookie_id=${cookie_id}`);
      }

      logger.warn(`账号已标记需要刷新: cookie_id=${cookie_id}`);
      return result.rows[0];
    } catch (error) {
      logger.error('标记账号需要刷新失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新账号状态
   * @param {string} cookie_id - Cookie ID
   * @param {number} status - 状态 (0=禁用, 1=启用)
   * @returns {Promise<Object>} 更新后的账号信息
   */
  async updateAccountStatus(cookie_id, status) {
    try {
      const result = await database.query(
        `UPDATE accounts 
         SET status = $1, updated_at = CURRENT_TIMESTAMP
         WHERE cookie_id = $2
         RETURNING *`,
        [status, cookie_id]
      );

      if (result.rows.length === 0) {
        throw new Error(`账号不存在: cookie_id=${cookie_id}`);
      }

      logger.info(`账号状态已更新: cookie_id=${cookie_id}, status=${status}`);
      return result.rows[0];
    } catch (error) {
      logger.error('更新账号状态失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新账号名称
   * @param {string} cookie_id - Cookie ID
   * @param {string} name - 新的账号名称
   * @returns {Promise<Object>} 更新后的账号信息
   */
  async updateAccountName(cookie_id, name) {
    try {
      const result = await database.query(
        `UPDATE accounts
         SET name = $1, updated_at = CURRENT_TIMESTAMP
         WHERE cookie_id = $2
         RETURNING *`,
        [name, cookie_id]
      );

      if (result.rows.length === 0) {
        throw new Error(`账号不存在: cookie_id=${cookie_id}`);
      }

      logger.info(`账号名称已更新: cookie_id=${cookie_id}, name=${name}`);
      return result.rows[0];
    } catch (error) {
      logger.error('更新账号名称失败:', error.message);
      throw error;
    }
  }

  /**
   * 删除账号
   * @param {string} cookie_id - Cookie ID
   * @returns {Promise<boolean>} 是否删除成功
   */
  async deleteAccount(cookie_id) {
    try {
      const result = await database.query(
        'DELETE FROM accounts WHERE cookie_id = $1',
        [cookie_id]
      );

      const deleted = result.rowCount > 0;
      if (deleted) {
        logger.info(`账号已删除: cookie_id=${cookie_id}`);
      } else {
        logger.warn(`账号不存在，无法删除: cookie_id=${cookie_id}`);
      }
      return deleted;
    } catch (error) {
      logger.error('删除账号失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新账号的project_id字段
   * @param {string} cookie_id - Cookie ID
   * @param {string} project_id_0 - Google Cloud项目ID
   * @param {boolean} is_restricted - 是否受地区限制
   * @param {boolean} ineligible - 是否不合格（INELIGIBLE_ACCOUNT）
   * @param {boolean|null} paid_tier - 是否付费用户（true=付费, false=免费, null=未知）
   * @returns {Promise<Object>} 更新后的账号信息
   */
  async updateProjectIds(cookie_id, project_id_0, is_restricted, ineligible = false, paid_tier = null) {
    try {
      const result = await database.query(
        `UPDATE accounts
         SET project_id_0 = $1, is_restricted = $2, ineligible = $3, paid_tier = $4, updated_at = CURRENT_TIMESTAMP
         WHERE cookie_id = $5
         RETURNING *`,
        [project_id_0, is_restricted, ineligible, paid_tier, cookie_id]
      );

      if (result.rows.length === 0) {
        throw new Error(`账号不存在: cookie_id=${cookie_id}`);
      }

      logger.info(`账号project_id已更新: cookie_id=${cookie_id}, project_id_0=${project_id_0}, is_restricted=${is_restricted}, ineligible=${ineligible}, paid_tier=${paid_tier}`);
      return result.rows[0];
    } catch (error) {
      logger.error('更新账号project_id失败:', error.message);
      throw error;
    }
  }

  /**
   * 检查账号token是否过期
   * @param {Object} account - 账号对象
   * @returns {boolean} 是否过期
   */
  isTokenExpired(account) {
    if (!account.expires_at) return true;
    // 提前5分钟认为过期
    return Date.now() >= account.expires_at - 300000;
  }
}

const accountService = new AccountService();
export default accountService;
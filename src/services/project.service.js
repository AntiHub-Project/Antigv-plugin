import logger from '../utils/logger.js';
import { generateProjectId } from '../utils/utils.js';
import accountService from './account.service.js';
import config from '../config/config.js';

class ProjectService {
  async loadCodeAssist(accessToken) {
    try {
      const requestHeaders = {
        'Host': 'daily-cloudcode-pa.sandbox.googleapis.com',
        'User-Agent': config.api.userAgent,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip'
      };

      const response = await fetch(
        'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
        {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify({
            metadata: {
              ideType: 'ANTIGRAVITY'
            }
          })
        }
      );

      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`API请求失败 (${response.status}): ${responseText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      logger.error('调用loadCodeAssist API失败:', error.message);
      throw error;
    }
  }

  /**
   * 处理API响应并更新账号的project_id字段
   * @param {string} cookie_id - Cookie ID
   * @param {string} accessToken - 访问令牌
   * @returns {Promise<Object>} 更新后的账号信息
   */
  async updateAccountProjectIds(cookie_id, accessToken) {
    try {
      // 调用API获取项目信息
      const apiResponse = await this.loadCodeAssist(accessToken);
      
      // 默认值
      let is_restricted = false;
      let ineligible = false;
      
      // 检查 ineligibleTiers 是否存在
      if (apiResponse.ineligibleTiers && apiResponse.ineligibleTiers.length > 0) {
        // 检查是否包含 INELIGIBLE_ACCOUNT
        const hasIneligibleAccount = apiResponse.ineligibleTiers.some(
          tier => tier.reasonCode === 'INELIGIBLE_ACCOUNT'
        );
        
        if (hasIneligibleAccount) {
          // 如果是 INELIGIBLE_ACCOUNT，设置 ineligible=true
          ineligible = true;
        }
        
        // 检查是否包含 UNSUPPORTED_LOCATION
        const hasUnsupportedLocation = apiResponse.ineligibleTiers.some(
          tier => tier.reasonCode === 'UNSUPPORTED_LOCATION'
        );
        
        if (hasUnsupportedLocation) {
          // 如果是 UNSUPPORTED_LOCATION，设置 is_restricted=true
          is_restricted = true;
        }
      }
      
      // 只要有 cloudaicompanionProject，就填入 project_id_0
      const project_id_0 = apiResponse.cloudaicompanionProject || '';
      
      // 更新数据库
      const updatedAccount = await accountService.updateProjectIds(
        cookie_id,
        project_id_0,
        is_restricted,
        ineligible
      );
      
      // 返回更新后的账号信息，并附加paidTier信息用于判断
      return {
        ...updatedAccount,
        paidTier: apiResponse.paidTier || []
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * 批量更新多个账号的project_id
   * @param {Array<Object>} accounts - 账号列表，每个账号包含 cookie_id 和 access_token
   * @returns {Promise<Array>} 更新结果列表
   */
  async batchUpdateProjectIds(accounts) {
    const results = [];
    
    for (const account of accounts) {
      try {
        const result = await this.updateAccountProjectIds(
          account.cookie_id,
          account.access_token
        );
        results.push({
          cookie_id: account.cookie_id,
          success: true,
          data: result
        });
      } catch (error) {
        results.push({
          cookie_id: account.cookie_id,
          success: false,
          error: error.message
        });
      }
    }
    
    return results;
  }
}

const projectService = new ProjectService();
export default projectService;
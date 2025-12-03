import crypto from 'crypto';
import https from 'https';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import accountService from './account.service.js';
import quotaService from './quota.service.js';
import projectService from './project.service.js';

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
];

class OAuthService {
  constructor() {
    // 存储临时state到user_id的映射
    this.stateMap = new Map();
  }

  /**
   * 获取回调URL（从配置文件读取）
   * @returns {string} 回调URL
   */
  getCallbackUrl() {
    return config.oauth?.callbackUrl || `http://localhost:42532/oauth-callback`;
  }

  /**
   * 生成OAuth授权URL
   * @param {string} user_id - 用户ID
   * @param {number} is_shared - 是否共享（0=专属, 1=共享）
   * @returns {Object} 包含auth_url和state的对象
   */
  generateAuthUrl(user_id, is_shared = 0) {
    const state = crypto.randomUUID();
    const callbackUrl = this.getCallbackUrl();
    
    // 保存state到user_id的映射（5分钟后过期）
    this.stateMap.set(state, { user_id, is_shared, timestamp: Date.now() });
    setTimeout(() => this.stateMap.delete(state), 5 * 60 * 1000);

    const params = new URLSearchParams({
      access_type: 'offline',
      client_id: CLIENT_ID,
      prompt: 'consent',
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: SCOPES.join(' '),
      state: state
    });

    const auth_url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    
    logger.info(`生成OAuth URL: user_id=${user_id}, state=${state}`);
    
    return {
      auth_url,
      state,
      expires_in: 300 // state 5分钟后过期
    };
  }

  /**
   * 验证state并获取用户信息
   * @param {string} state - OAuth state参数
   * @returns {Object|null} 用户信息或null
   */
  getStateInfo(state) {
    const info = this.stateMap.get(state);
    if (!info) {
      return null;
    }

    // 检查是否过期（5分钟）
    if (Date.now() - info.timestamp > 5 * 60 * 1000) {
      this.stateMap.delete(state);
      return null;
    }

    return info;
  }

  /**
   * 交换授权码获取token
   * @param {string} code - 授权码
   * @returns {Promise<Object>} Token数据
   */
  async exchangeCodeForToken(code) {
    const callbackUrl = this.getCallbackUrl();
    const requestId = crypto.randomUUID().substring(0, 8);
    const startTime = Date.now();
    
    logger.info(`[${requestId}] 开始Token交换流程`);
    logger.info(`[${requestId}] 请求参数:`, {
      code_length: code ? code.length : 0,
      client_id: CLIENT_ID,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code',
      has_client_secret: !!CLIENT_SECRET
    });
    
    return new Promise((resolve, reject) => {
      const postData = new URLSearchParams({
        code: code,
        client_id: CLIENT_ID,
        redirect_uri: callbackUrl,
        grant_type: 'authorization_code'
      });
      
      if (CLIENT_SECRET) {
        postData.append('client_secret', CLIENT_SECRET);
      }
      
      const data = postData.toString();
      
      const options = {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data)
        }
      };
      
      const req = https.request(options, (res) => {
        const responseStartTime = Date.now();
        
        let body = '';
        let chunkCount = 0;
        let totalBytes = 0;
        
        res.on('data', chunk => {
          chunkCount++;
          totalBytes += chunk.length;
          body += chunk;
        });
        
        res.on('end', () => {
          const totalTime = Date.now() - startTime;
          const responseTime = Date.now() - responseStartTime;
          
          if (res.statusCode === 200) {
            try {
              const tokenData = JSON.parse(body);
              resolve(tokenData);
            } catch (parseError) {
              logger.error(`[${requestId}] JSON解析失败:`, parseError.message);
              logger.error(`[${requestId}] 原始响应:`, body);
              reject(new Error(`JSON解析失败: ${parseError.message}`));
            }
          } else {
            logger.error(`[${requestId}] Token交换失败:`, {
              status_code: res.statusCode,
              status_message: res.statusMessage,
              response_body: body,
              response_size: body.length
            });
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      });
      
      req.on('error', (error) => {
        const totalTime = Date.now() - startTime;
        logger.error(`[${requestId}] 请求异常:`, {
          error_message: error.message,
          error_code: error.code,
          error_stack: error.stack,
          total_time_ms: totalTime
        });
        reject(error);
      });
      
      req.on('socket', (socket) => {
        socket.on('connect', () => {
          logger.info(`[${requestId}] TCP连接建立`);
        });
        socket.on('timeout', () => {
          logger.warn(`[${requestId}] Socket超时`);
        });
      });
      
      req.write(data);
      req.end();
      
      logger.info(`[${requestId}] 请求已发送，等待响应...`);
    });
  }

  /**
   * 刷新访问令牌
   * @param {string} refresh_token - 刷新令牌
   * @returns {Promise<Object>} 新的token数据
   */
  async refreshAccessToken(refresh_token) {
    const requestId = crypto.randomUUID().substring(0, 8);
    const startTime = Date.now();
    
    logger.info(`[${requestId}] 开始刷新Token流程`);
    logger.info(`[${requestId}] 请求参数:`, {
      refresh_token_length: refresh_token ? refresh_token.length : 0,
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      has_client_secret: !!CLIENT_SECRET
    });
    
    return new Promise((resolve, reject) => {
      const postData = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refresh_token
      });

      const data = postData.toString();

      const options = {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = https.request(options, (res) => {
        const responseStartTime = Date.now();
        
        let body = '';
        let chunkCount = 0;
        let totalBytes = 0;
        
        res.on('data', chunk => {
          chunkCount++;
          totalBytes += chunk.length;
          body += chunk;
        });
        
        res.on('end', () => {
          const totalTime = Date.now() - startTime;
          const responseTime = Date.now() - responseStartTime;
          
          if (res.statusCode === 200) {
            try {
              const tokenData = JSON.parse(body);
              resolve(tokenData);
            } catch (parseError) {
              logger.error(`[${requestId}] JSON解析失败:`, parseError.message);
              logger.error(`[${requestId}] 原始响应:`, body);
              reject(new Error(`JSON解析失败: ${parseError.message}`));
            }
          } else {
            // 解析错误响应以获取更详细的错误信息
            let errorInfo = {
              status_code: res.statusCode,
              status_message: res.statusMessage,
              response_body: body,
              response_size: body.length
            };
            
            let isInvalidGrant = false;
            try {
              const errorData = JSON.parse(body);
              errorInfo.error = errorData.error;
              errorInfo.error_description = errorData.error_description;
              
              // 特别处理 invalid_grant 错误
              if (errorData.error === 'invalid_grant') {
                isInvalidGrant = true;
                logger.error(`[${requestId}] Token刷新失败 - invalid_grant:`, {
                  ...errorInfo,
                  possible_causes: [
                    'refresh_token已过期（Google refresh_token通常6个月后过期）',
                    'refresh_token已被撤销',
                    '用户已更改密码',
                    '用户已撤销应用授权',
                    'refresh_token已被使用过（某些情况下只能使用一次）'
                  ]
                });
              } else {
                logger.error(`[${requestId}] Token刷新失败:`, errorInfo);
              }
            } catch (parseErr) {
              logger.error(`[${requestId}] Token刷新失败:`, errorInfo);
            }
            
            // 创建错误对象，标记是否为 invalid_grant
            const error = new Error(`HTTP ${res.statusCode}: ${body}`);
            error.isInvalidGrant = isInvalidGrant;
            reject(error);
          }
        });
      });

      req.on('error', (error) => {
        const totalTime = Date.now() - startTime;
        logger.error(`[${requestId}] 请求异常:`, {
          error_message: error.message,
          error_code: error.code,
          error_stack: error.stack,
          total_time_ms: totalTime
        });
        reject(error);
      });
      
      req.on('socket', (socket) => {
        socket.on('connect', () => {
          logger.info(`[${requestId}] TCP连接建立`);
        });
        socket.on('timeout', () => {
          logger.warn(`[${requestId}] Socket超时`);
        });
      });

      req.write(data);
      req.end();
      
      logger.info(`[${requestId}] 请求已发送，等待响应...`);
    });
  }

  /**
   * 获取用户信息（email等）
   * @param {string} access_token - 访问令牌
   * @returns {Promise<Object>} 用户信息
   */
  async getUserInfo(access_token) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'www.googleapis.com',
        path: '/oauth2/v2/userinfo',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${access_token}`
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        
        res.on('data', chunk => {
          body += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const userInfo = JSON.parse(body);
              resolve(userInfo);
            } catch (parseError) {
              reject(new Error(`解析失败: ${parseError.message}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', (error) => {
        logger.error('获取用户信息请求异常:', error.message);
        reject(error);
      });

      req.end();
    });
  }

  /**
   * 处理OAuth回调
   * @param {string} code - 授权码
   * @param {string} state - State参数
   * @returns {Promise<Object>} 创建的账号信息
   */
  async handleCallback(code, state) {
    // 验证state
    const stateInfo = this.getStateInfo(state);
    if (!stateInfo) {
      throw new Error('Invalid or expired state parameter');
    }

    const { user_id, is_shared } = stateInfo;

    // 交换授权码获取token
    const tokenData = await this.exchangeCodeForToken(code);

    // 生成cookie_id（使用refresh_token的hash作为唯一标识）
    const cookie_id = crypto
      .createHash('sha256')
      .update(tokenData.refresh_token)
      .digest('hex')
      .substring(0, 32);

    // 计算过期时间
    const expires_at = Date.now() + (tokenData.expires_in * 1000);

    // 获取用户信息（email）
    let accountName = null;
    try {
      const userInfo = await this.getUserInfo(tokenData.access_token);
      if (userInfo.email) {
        accountName = userInfo.email;
        logger.info(`获取到账号email: ${accountName}`);
      }
    } catch (error) {
      logger.warn(`获取用户信息失败，将使用默认名称: ${error.message}`);
    }

    // 第一步：获取project_id并检查账号资格
    let project_id_0 = '';
    let is_restricted = false;
    let ineligible = null;
    
    try {
      const projectData = await projectService.loadCodeAssist(tokenData.access_token);
      
      // 检查是否为 INELIGIBLE_ACCOUNT
      if (projectData.ineligibleTiers && projectData.ineligibleTiers.length > 0) {
        const hasIneligibleAccount = projectData.ineligibleTiers.some(
          tier => tier.reasonCode === 'INELIGIBLE_ACCOUNT'
        );
        
        if (hasIneligibleAccount) {
          logger.error(`账号不符合使用条件 (INELIGIBLE_ACCOUNT): cookie_id=${cookie_id}`);
          this.stateMap.delete(state);
          throw new Error('此账号没有资格使用Antigravity: INELIGIBLE_ACCOUNT');
        }
        
        // 检查是否为 UNSUPPORTED_LOCATION
        const hasUnsupportedLocation = projectData.ineligibleTiers.some(
          tier => tier.reasonCode === 'UNSUPPORTED_LOCATION'
        );
        
        if (hasUnsupportedLocation) {
          is_restricted = true;
          logger.info(`账号受地区限制: cookie_id=${cookie_id}`);
        }
      }
      
      // 检查是否有cloudaicompanionProject
      if (!projectData.cloudaicompanionProject) {
        // 检查paidTier中是否包含free
        const hasFree = projectData.paidTier && projectData.paidTier.some(
          tier => tier.id === 'free'
        );
        
        if (hasFree) {
          // 如果有free tier，则阻止登录
          let reason = 'UNKNOWN_ERROR';
          if (projectData.ineligibleTiers && projectData.ineligibleTiers.length > 0) {
            // 如果有ineligibleTiers，使用第一个reasonCode
            reason = projectData.ineligibleTiers[0].reasonCode || 'UNKNOWN_ERROR';
          }
          
          ineligible = reason;
          logger.error(`账号缺少cloudaicompanionProject且有free tier: cookie_id=${cookie_id}, reason=${reason}`);
          this.stateMap.delete(state);
          throw new Error(`此账号没有资格使用Antigravity: ${reason}`);
        } else {
          // 没有free tier，允许登录但project_id_0为空
          logger.info(`账号缺少cloudaicompanionProject但无free tier，允许登录: cookie_id=${cookie_id}`);
        }
      }
      
      // 获取project_id_0
      if (!is_restricted) {
        project_id_0 = projectData.cloudaicompanionProject;
      }
      
    } catch (error) {
      // 如果是已知的账号资格错误，直接抛出
      if (error.message.includes('原因:')) {
        throw error;
      }
      // 其他未知错误也阻止登录
      logger.error(`project_id获取失败: cookie_id=${cookie_id}, error=${error.message}`);
      this.stateMap.delete(state);
      throw new Error('此账号没有资格使用Antigravity: UNKNOWN_ERROR');
    }

    let mergedModels = {};
    
    // 使用project_id_0获取配额
    if (project_id_0) {
      try {
        const response0 = await fetch(config.api.modelsUrl, {
          method: 'POST',
          headers: {
            'Host': config.api.host,
            'User-Agent': config.api.userAgent,
            'Authorization': `Bearer ${tokenData.access_token}`,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip'
          },
          body: JSON.stringify({ project: project_id_0 })
        });

        if (response0.ok) {
          const data0 = await response0.json();
          if (data0.models) {
            mergedModels = { ...data0.models };
          }
        } else {
          logger.warn(`project_id_0配额获取失败: status=${response0.status}`);
        }
      } catch (error) {
        logger.warn(`project_id_0配额获取异常: ${error.message}`);
      }
    }
    
    logger.info(`配额获取完成: cookie_id=${cookie_id}, 共${Object.keys(mergedModels).length}个模型`);

    // 第三步：创建账号
    const account = await accountService.createAccount({
      cookie_id,
      user_id,
      is_shared,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at,
      project_id_0,
      is_restricted,
      ineligible,
      name: accountName
    });

    // 更新model_quotas表
    await quotaService.updateQuotasFromModels(cookie_id, mergedModels);
    
    const modelNames = Object.keys(mergedModels);
    
    // 如果是共享cookie，更新用户共享配额池上限（2*n）
    if (is_shared === 1) {
      for (const modelName of modelNames) {
        await quotaService.updateUserSharedQuotaMax(user_id, modelName);
      }
    }

    // 清除state映射
    this.stateMap.delete(state);

    logger.info(`OAuth回调处理成功: cookie_id=${cookie_id}, user_id=${user_id}, ${modelNames.length}个可用模型`);

    return account;
  }
}

const oauthService = new OAuthService();
export default oauthService;
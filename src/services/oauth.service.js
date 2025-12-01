import crypto from 'crypto';
import https from 'https';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import accountService from './account.service.js';
import quotaService from './quota.service.js';

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
      
      logger.info(`[${requestId}] 发送HTTPS请求:`, {
        hostname: options.hostname,
        path: options.path,
        method: options.method,
        headers: {
          'Content-Type': options.headers['Content-Type'],
          'Content-Length': options.headers['Content-Length']
        },
        body_size: Buffer.byteLength(data)
      });
      
      const req = https.request(options, (res) => {
        const responseStartTime = Date.now();
        logger.info(`[${requestId}] 收到响应:`, {
          status_code: res.statusCode,
          status_message: res.statusMessage,
          headers: res.headers,
          http_version: res.httpVersion
        });
        
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
          
          logger.info(`[${requestId}] 响应接收完成:`, {
            total_chunks: chunkCount,
            total_bytes: totalBytes,
            response_time_ms: responseTime,
            total_time_ms: totalTime
          });
          
          if (res.statusCode === 200) {
            try {
              const tokenData = JSON.parse(body);
              logger.info(`[${requestId}] Token交换成功:`, {
                access_token_length: tokenData.access_token ? tokenData.access_token.length : 0,
                refresh_token_length: tokenData.refresh_token ? tokenData.refresh_token.length : 0,
                expires_in: tokenData.expires_in,
                token_type: tokenData.token_type,
                scope: tokenData.scope
              });
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
      
      logger.info(`[${requestId}] 发送HTTPS请求:`, {
        hostname: options.hostname,
        path: options.path,
        method: options.method,
        headers: {
          'Content-Type': options.headers['Content-Type'],
          'Content-Length': options.headers['Content-Length']
        },
        body_size: Buffer.byteLength(data)
      });

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
              logger.info(`[${requestId}] Token刷新成功:`, {
                access_token_length: tokenData.access_token ? tokenData.access_token.length : 0,
                expires_in: tokenData.expires_in,
                token_type: tokenData.token_type,
                scope: tokenData.scope,
                has_refresh_token: !!tokenData.refresh_token
              });
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

    // 先验证账号权限：尝试获取模型列表
    logger.info(`验证账号权限: cookie_id=${cookie_id}`);
    const response = await fetch(config.api.modelsUrl, {
      method: 'POST',
      headers: {
        'Host': config.api.host,
        'User-Agent': config.api.userAgent,
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      body: JSON.stringify({})
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`账号无权限访问API (${response.status}): ${errorText}`);
      throw new Error(`该账号无权限使用Antigravity API。错误: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    if (!data.models || Object.keys(data.models).length === 0) {
      logger.error('账号返回的模型列表为空');
      throw new Error('该账号无可用模型，请检查账号权限');
    }

    // 权限验证通过，创建账号
    const account = await accountService.createAccount({
      cookie_id,
      user_id,
      is_shared,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at
    });

    // 更新model_quotas表（共享和专属cookie都需要）
    await quotaService.updateQuotasFromModels(cookie_id, data.models);
    
    const modelNames = Object.keys(data.models);
    
    // 如果是共享cookie，更新用户共享配额池上限（2*n）
    if (is_shared === 1) {
      for (const modelName of modelNames) {
        await quotaService.updateUserSharedQuotaMax(user_id, modelName);
      }
      logger.info(`用户共享配额池上限已更新: user_id=${user_id}, ${modelNames.length}个模型`);
    }

    // 清除state映射
    this.stateMap.delete(state);

    logger.info(`OAuth回调处理成功: cookie_id=${cookie_id}, user_id=${user_id}, ${modelNames.length}个可用模型`);

    return account;
  }
}

const oauthService = new OAuthService();
export default oauthService;
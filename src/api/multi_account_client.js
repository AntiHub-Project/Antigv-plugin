import config from '../config/config.js';
import logger from '../utils/logger.js';
import accountService from '../services/account.service.js';
import quotaService from '../services/quota.service.js';
import oauthService from '../services/oauth.service.js';
import signatureService from '../services/signature.service.js';

/**
 * 自定义API错误类，包含HTTP状态码
 */
class ApiError extends Error {
  constructor(message, statusCode, responseText) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.responseText = responseText;
  }
}

/**
 * 多账号API客户端
 * 支持从数据库获取账号并进行轮询
 */
class MultiAccountClient {
  constructor() {
  }

  /**
   * 获取可用的账号token（带配额检查）
   * @param {string} user_id - 用户ID
   * @param {string} model_name - 模型名称
   * @param {Object} user - 用户对象（包含prefer_shared）
   * @param {Array} excludeCookieIds - 要排除的cookie_id列表（用于重试时排除已失败的账号）
   * @returns {Promise<Object>} 账号对象
   */
  async getAvailableAccount(user_id, model_name, user, excludeCookieIds = []) {
    // 确保 prefer_shared 有明确的值（默认为0 - 专属优先）
    const preferShared = user?.prefer_shared ?? 0;
    let accounts = [];
    
    logger.info(`========== 开始获取可用账号 ==========`);
    logger.info(`用户信息 - user_id=${user_id}, prefer_shared=${preferShared} (原始值: ${user?.prefer_shared}), model=${model_name}`);
    
    // 根据用户优先级选择cookie
    if (preferShared === 1) {
      // 共享优先：先尝试共享cookie，再尝试专属cookie
      logger.info(`执行共享优先策略...`);
      const sharedAccounts = await accountService.getAvailableAccounts(null, 1);
      const dedicatedAccounts = await accountService.getAvailableAccounts(user_id, 0);
      accounts = sharedAccounts.concat(dedicatedAccounts);
      logger.info(`共享优先模式 - 共享账号=${sharedAccounts.length}个, 专属账号=${dedicatedAccounts.length}个, 总计=${accounts.length}个`);
    } else {
      // 专属优先：先尝试专属cookie，再尝试共享cookie
      logger.info(`执行专属优先策略...`);
      const dedicatedAccounts = await accountService.getAvailableAccounts(user_id, 0);
      const sharedAccounts = await accountService.getAvailableAccounts(null, 1);
      accounts = dedicatedAccounts.concat(sharedAccounts);
      logger.info(`专属优先模式 - 专属账号=${dedicatedAccounts.length}个, 共享账号=${sharedAccounts.length}个, 总计=${accounts.length}个`);
    }

    // 排除已经尝试失败的账号
    if (excludeCookieIds.length > 0) {
      accounts = accounts.filter(acc => !excludeCookieIds.includes(acc.cookie_id));
      logger.info(`排除失败账号后剩余: ${accounts.length}个`);
    }

    if (accounts.length === 0) {
      throw new Error('没有可用的账号，请添加账号');
    }

    // 过滤出对该模型可用的账号
    const availableAccounts = [];
    for (const account of accounts) {
      const isAvailable = await quotaService.isModelAvailable(account.cookie_id, model_name);
      if (isAvailable) {
        // 如果是共享cookie，检查用户共享配额池
        if (account.is_shared === 1) {
          // 获取该模型所属的配额共享组
          const sharedModels = quotaService.getQuotaSharedModels(model_name);
          
          // 检查用户是否有该共享组中任意模型的配额
          let hasQuota = false;
          for (const sharedModel of sharedModels) {
            const userQuota = await quotaService.getUserModelSharedQuotaPool(user_id, sharedModel);
            if (userQuota && userQuota.quota > 0) {
              hasQuota = true;
              break;
            }
          }
          
          if (!hasQuota) {
            continue; // 跳过此共享cookie
          }
        }
        availableAccounts.push(account);
      }
    }

    if (availableAccounts.length === 0) {
      throw new Error(`所有账号对模型 ${model_name} 的配额已耗尽或用户共享配额不足`);
    }

    // 根据优先级选择账号：优先从第一优先级的账号池中随机选择
    let selectedPool = [];
    let poolType = '';
    
    if (preferShared === 1) {
      // 共享优先：先尝试从共享账号中选择
      const sharedAvailable = availableAccounts.filter(acc => acc.is_shared === 1);
      if (sharedAvailable.length > 0) {
        selectedPool = sharedAvailable;
        poolType = '共享账号池';
      } else {
        selectedPool = availableAccounts.filter(acc => acc.is_shared === 0);
        poolType = '专属账号池（共享池无可用账号）';
      }
    } else {
      // 专属优先：先尝试从专属账号中选择
      const dedicatedAvailable = availableAccounts.filter(acc => acc.is_shared === 0);
      if (dedicatedAvailable.length > 0) {
        selectedPool = dedicatedAvailable;
        poolType = '专属账号池';
      } else {
        selectedPool = availableAccounts.filter(acc => acc.is_shared === 1);
        poolType = '共享账号池（专属池无可用账号）';
      }
    }

    // 从选定的池中随机选择
    const randomIndex = Math.floor(Math.random() * selectedPool.length);
    const account = selectedPool[randomIndex];
    
    logger.info(`========== 最终选择账号 ==========`);
    logger.info(`选中账号: cookie_id=${account.cookie_id}, is_shared=${account.is_shared}, user_id=${account.user_id}`);

    // 检查token是否过期，如果过期则刷新
    if (accountService.isTokenExpired(account)) {
      logger.info(`账号token已过期，正在刷新: cookie_id=${account.cookie_id}`);
      try {
        const tokenData = await oauthService.refreshAccessToken(account.refresh_token);
        const expires_at = Date.now() + (tokenData.expires_in * 1000);
        await accountService.updateAccountToken(account.cookie_id, tokenData.access_token, expires_at);
        account.access_token = tokenData.access_token;
        account.expires_at = expires_at;
      } catch (refreshError) {
        // 如果是 invalid_grant 错误，直接禁用账号
        if (refreshError.isInvalidGrant) {
          logger.error(`账号刷新token失败(invalid_grant)，禁用账号: cookie_id=${account.cookie_id}`);
          await accountService.updateAccountStatus(account.cookie_id, 0);
        } else {
          // 其他错误，标记需要重新授权
          logger.error(`账号刷新token失败，标记需要重新授权: cookie_id=${account.cookie_id}, error=${refreshError.message}`);
          await accountService.markAccountNeedRefresh(account.cookie_id);
        }
        
        // 尝试获取下一个可用账号
        const newExcludeList = [...excludeCookieIds, account.cookie_id];
        return this.getAvailableAccount(user_id, model_name, user, newExcludeList);
      }
    }

    return account;
  }

  /**
   * 生成助手响应（使用多账号）
   * @param {Object} requestBody - 请求体
   * @param {Function} callback - 回调函数
   * @param {string} user_id - 用户ID
   * @param {string} model_name - 模型名称
   * @param {Object} user - 用户对象
   * @param {Array} originalMessages - 原始 OpenAI 格式的消息数组（用于 signature 管理）
   * @param {Object} account - 账号对象（可选，如果不提供则自动获取）
   * @param {Array} excludeCookieIds - 要排除的cookie_id列表（用于重试时排除已失败的账号）
   */
  async generateResponse(requestBody, callback, user_id, model_name, user, originalMessages = [], account = null, excludeCookieIds = []) {
    // 如果没有提供 account，则获取一个
    if (!account) {
      account = await this.getAvailableAccount(user_id, model_name, user, excludeCookieIds);
    }
    
    // 判断是否为 Gemini 模型
    // Gemini 的思考内容需要转换为 OpenAI 兼容的 reasoning_content 格式
    const isGeminiModel = model_name.startsWith('gemini-');
    
    // 使用缓存的配额信息，不阻塞请求
    let quotaBefore = null;
    try {
      const quotaInfo = await quotaService.getQuota(account.cookie_id, model_name);
      quotaBefore = quotaInfo ? parseFloat(quotaInfo.quota) : null;
      
      // 检查缓存是否过期（超过5分钟），如果过期则在后台异步刷新
      if (quotaInfo?.last_fetched_at) {
        const cacheAge = Date.now() - new Date(quotaInfo.last_fetched_at).getTime();
        const CACHE_TTL = 5 * 60 * 1000; // 5分钟
        if (cacheAge > CACHE_TTL) {
          logger.info(`配额缓存已过期(${Math.round(cacheAge/1000)}秒)，后台异步刷新`);
          // 异步刷新，不阻塞请求
          this.refreshCookieQuota(account.cookie_id, account.access_token).catch(err => {
            logger.warn('后台刷新配额失败:', err.message);
          });
        }
      }
      
      logger.info(`对话开始 - cookie_id=${account.cookie_id}, model=${model_name}, quota_before=${quotaBefore} (缓存值)`);
    } catch (error) {
      logger.warn('获取缓存配额失败:', error.message);
    }
    
    // 使用账号的 project_id_0
    if (account.project_id_0) {
      requestBody.project = account.project_id_0;
    }
    
    const url = config.api.url;
    
    const requestHeaders = {
      'Host': config.api.host,
      'User-Agent': config.api.userAgent,
      'Authorization': `Bearer ${account.access_token}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip'
    };
    
    let response;
    
    try {
      // 创建 AbortController 用于超时控制
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 600000); // 10分钟超时
      
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
      
      if (!response.ok) {
        const responseText = await response.text();
        
        if (response.status === 403) {
          logger.warn(`账号没有使用权限(403)，已禁用: cookie_id=${account.cookie_id}`);
          await accountService.updateAccountStatus(account.cookie_id, 0);
        }
        
        // 检查是否是400错误（可能是账号问题）
        if (response.status === 400) {
          // 检查是否是配额耗尽错误，自动更换账号重试
          if (responseText.includes('quota') || responseText.includes('RESOURCE_EXHAUSTED')) {
            logger.warn(`[400错误] 账号配额耗尽，尝试更换账号重试: cookie_id=${account.cookie_id}`);
            
            // 将当前账号加入排除列表
            const newExcludeList = [...excludeCookieIds, account.cookie_id];
            
            try {
              // 尝试获取新账号并重试
              const newAccount = await this.getAvailableAccount(user_id, model_name, user, newExcludeList);
              logger.info(`已获取新账号，重试请求: new_cookie_id=${newAccount.cookie_id}`);
              
              // 更新 requestBody 中的 project
              if (newAccount.project_id_0) {
                requestBody.project = newAccount.project_id_0;
              }
              
              // 递归调用，使用新账号重试
              return await this.generateResponse(requestBody, callback, user_id, model_name, user, originalMessages, newAccount, newExcludeList);
            } catch (retryError) {
              // 如果没有更多可用账号，返回配额耗尽错误
              logger.error(`所有账号配额已耗尽，无法重试: ${retryError.message}`);
              callback({ type: 'error', content: 'RESOURCE_EXHAUSTED' });
              return;
            }
          }
          // 检查是否是图片超过5MB的错误
          if (responseText.includes('image exceeds 5 MB maximum')) {
            logger.warn(`[400错误] 图片超过5MB限制`);
            callback({ type: 'error', content: 'IMAGE_INPUT_EXCEEDED_MAXIMUM_5_MB' });
            throw new ApiError('IMAGE_INPUT_EXCEEDED_MAXIMUM_5_MB', 400, 'IMAGE_INPUT_EXCEEDED_MAXIMUM_5_MB');
          }
          // 检查是否是 RESOURCE_PROJECT_INVALID 错误，禁用账号并换号重试
          if (responseText.includes('RESOURCE_PROJECT_INVALID')) {
            logger.warn(`[400错误] RESOURCE_PROJECT_INVALID，禁用账号并尝试更换账号重试: cookie_id=${account.cookie_id}`);
            await accountService.updateAccountStatus(account.cookie_id, 0);
            
            // 将当前账号加入排除列表
            const newExcludeList = [...excludeCookieIds, account.cookie_id];
            
            try {
              // 尝试获取新账号并重试
              const newAccount = await this.getAvailableAccount(user_id, model_name, user, newExcludeList);
              logger.info(`已获取新账号，重试请求: new_cookie_id=${newAccount.cookie_id}`);
              
              // 更新 requestBody 中的 project
              if (newAccount.project_id_0) {
                requestBody.project = newAccount.project_id_0;
              }
              
              // 递归调用，使用新账号重试
              return await this.generateResponse(requestBody, callback, user_id, model_name, user, originalMessages, newAccount, newExcludeList);
            } catch (retryError) {
              // 如果没有更多可用账号，返回错误
              logger.error(`所有账号都不可用，无法重试: ${retryError.message}`);
              callback({ type: 'error', content: 'RESOURCE_PROJECT_INVALID' });
              throw new ApiError('RESOURCE_PROJECT_INVALID', 400, 'RESOURCE_PROJECT_INVALID');
            }
          }
          // 检查是否是 INVALID_ARGUMENT 或 invalid_request_error 错误（请求参数问题，不应禁用账号）
          if (responseText.includes('INVALID_ARGUMENT') || responseText.includes('invalid_request_error')) {
            logger.warn(`[400错误] 参数错误(INVALID_ARGUMENT/invalid_request_error)，不禁用账号: cookie_id=${account.cookie_id}, error=${responseText.substring(0, 200)}`);
            // 将上游响应传递给回调，以便 dump
            callback({ type: 'error', content: responseText, upstreamResponse: responseText, upstreamRequest: requestBody });
            throw new ApiError(responseText, response.status, responseText);
          }
          // 其他400错误，禁用账号
          logger.warn(`账号请求失败(400)，已禁用: cookie_id=${account.cookie_id}, error=${responseText.substring(0, 200)}`);
          await accountService.updateAccountStatus(account.cookie_id, 0);
          // 将上游响应传递给回调，以便 dump
          callback({ type: 'error', content: responseText, upstreamResponse: responseText, upstreamRequest: requestBody });
          throw new ApiError(responseText, response.status, responseText);
        }
        
        // 检查是否是429配额耗尽错误，自动更换账号重试
        if (response.status === 429 || responseText.includes('quota') || responseText.includes('RESOURCE_EXHAUSTED')) {
          logger.warn(`[429错误] 账号配额耗尽，尝试更换账号重试: cookie_id=${account.cookie_id}`);
          
          // 将当前账号加入排除列表
          const newExcludeList = [...excludeCookieIds, account.cookie_id];
          
          try {
            // 尝试获取新账号并重试
            const newAccount = await this.getAvailableAccount(user_id, model_name, user, newExcludeList);
            logger.info(`已获取新账号，重试请求: new_cookie_id=${newAccount.cookie_id}`);
            
            // 更新 requestBody 中的 project
            if (newAccount.project_id_0) {
              requestBody.project = newAccount.project_id_0;
            }
            
            // 递归调用，使用新账号重试
            return await this.generateResponse(requestBody, callback, user_id, model_name, user, originalMessages, newAccount, newExcludeList);
          } catch (retryError) {
            // 如果没有更多可用账号，返回配额耗尽错误
            logger.error(`所有账号配额已耗尽，无法重试: ${retryError.message}`);
            callback({ type: 'error', content: 'RESOURCE_EXHAUSTED' });
            return;
          }
        }
        
        // 检查是否是500错误且包含 "Internal error encountered"
        if (response.status === 500 && responseText.includes('Internal error encountered')) {
          logger.error(`[500错误] Internal error encountered，返回 ILLEGAL_PROMPT`);
          callback({ type: 'error', content: 'ILLEGAL_PROMPT', upstreamResponse: responseText, upstreamRequest: requestBody });
          throw new ApiError('ILLEGAL_PROMPT', 500, 'ILLEGAL_PROMPT');
        }
        
        // 其他错误
        // 将上游响应传递给回调，以便 dump
        callback({ type: 'error', content: responseText, upstreamResponse: responseText, upstreamRequest: requestBody });
        throw new ApiError(responseText, response.status, responseText);
      }
      
    } catch (error) {
      // 如果还没有开始读取响应流，直接抛出错误
      throw error;
    }

    // 从这里开始是流式传输，错误需要通过callback返回
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let reasoningContent = ''; // 累积 reasoning_content
    let toolCalls = [];
    let generatedImages = [];
    let buffer = ''; // 用于处理跨chunk的JSON
    let collectedSignature = null; // 只收集第一个 signature
    let hasToolCalls = false; // 标记是否有 tool calls
    let collectedParts = []; // 收集所有原始 parts 用于日志打印
    let fullTextContent = ''; // 累积完整的文本内容
    let lastFinishReason = null; // 记录最后的 finishReason

    let chunkCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      
      const chunk = decoder.decode(value, { stream: true });
      chunkCount++;
      
      buffer += chunk;
      
      const lines = buffer.split('\n');
      // 保留最后一行(可能不完整)
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        
        try {
          const data = JSON.parse(jsonStr);
          
          const parts = data.response?.candidates?.[0]?.content?.parts;
          
          // 记录 finishReason
          if (data.response?.candidates?.[0]?.finishReason) {
            lastFinishReason = data.response.candidates[0].finishReason;
          }
          
          if (parts) {
            // 收集原始 parts 用于日志（深拷贝以保留原始数据）
            for (const part of parts) {
              // 深拷贝 part，但对于 inlineData 只保留元信息
              const partCopy = { ...part };
              if (partCopy.inlineData) {
                partCopy.inlineData = {
                  mimeType: partCopy.inlineData.mimeType,
                  dataLength: partCopy.inlineData.data?.length || 0
                };
              }
              collectedParts.push(partCopy);
            }
            
            // 只提取第一个 signature
            if (!collectedSignature) {
              const sig = signatureService.extractSignatureFromResponse(parts);
              if (sig) {
                collectedSignature = sig;
                logger.info(`提取到 thought signature: ${sig.substring(0, 20)}...`);
              }
            }
            
            for (const part of parts) {
              if (part.thought === true) {
                // Gemini 的思考内容转换为 OpenAI 兼容的 reasoning_content 格式
                // 累积思考内容，稍后一起发送
                reasoningContent += part.text || '';
                callback({ type: 'reasoning', content: part.text || '' });
              } else if (part.text !== undefined) {
                // 过滤掉空的非thought文本
                if (part.text.trim() === '') {
                  continue;
                }
                fullTextContent += part.text; // 累积文本内容
                callback({ type: 'text', content: part.text });
              } else if (part.inlineData) {
                // 处理生成的图像
                generatedImages.push({
                  mimeType: part.inlineData.mimeType,
                  data: part.inlineData.data
                });
                callback({
                  type: 'image',
                  image: {
                    mimeType: part.inlineData.mimeType,
                    data: part.inlineData.data
                  }
                });
              } else if (part.functionCall) {
                hasToolCalls = true;
                toolCalls.push({
                  id: part.functionCall.id,
                  type: 'function',
                  function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args)
                  }
                });
              }
            }
          }
          
          if (data.response?.candidates?.[0]?.finishReason) {
            if (toolCalls.length > 0) {
              callback({ type: 'tool_calls', tool_calls: toolCalls });
              toolCalls = [];
            }
          }
        } catch (e) {
          logger.warn(`JSON解析失败: ${e.message}`);
        }
      }
    }

    // 只有当有 tool calls 时才存储 signature
    if (collectedSignature && hasToolCalls && user_id) {
      try {
        await signatureService.storeSignature(user_id, collectedSignature);
      } catch (error) {
        logger.error('存储 thought signature 失败:', error.message);
      }
    }

    // 对话完成后，更新配额信息并记录消耗
    try {
      const quotaAfter = await this.updateQuotaAfterCompletion(account.cookie_id, model_name);
      
      // 记录配额消耗（所有cookie都记录）
      if (quotaBefore !== null && quotaAfter !== null) {
        let consumed = parseFloat(quotaBefore) - parseFloat(quotaAfter);
        
        // 如果消耗为负数，说明配额在请求期间重置了，记录消耗为0
        if (consumed < 0) {
          logger.info(`配额在请求期间重置，记录消耗为0 - quota_before=${quotaBefore}, quota_after=${quotaAfter}`);
          consumed = 0;
        }
        
        await quotaService.recordQuotaConsumption(
          user_id,
          account.cookie_id,
          model_name,
          quotaBefore,
          quotaAfter,
          account.is_shared
        );
        logger.info(`配额消耗已记录 - user_id=${user_id}, is_shared=${account.is_shared}, consumed=${consumed.toFixed(4)}`);
      } else {
        logger.warn(`无法记录配额消耗 - quotaBefore=${quotaBefore}, quotaAfter=${quotaAfter}`);
      }
    } catch (error) {
      logger.error('更新配额或记录消耗失败:', error.message, error.stack);
      // 不影响主流程，只记录错误
    }
  }

  /**
   * 获取可用模型列表
   * @param {string} user_id - 用户ID
   * @returns {Promise<Object>} 模型列表
   */
  async getAvailableModels(user_id) {
    // 获取任意一个可用账号
    const accounts = await accountService.getAvailableAccounts(user_id);
    
    if (accounts.length === 0) {
      throw new Error('没有可用的账号');
    }

    const account = accounts[0];

    // 检查token是否过期
    if (accountService.isTokenExpired(account)) {
      try {
        const tokenData = await oauthService.refreshAccessToken(account.refresh_token);
        const expires_at = Date.now() + (tokenData.expires_in * 1000);
        await accountService.updateAccountToken(account.cookie_id, tokenData.access_token, expires_at);
        account.access_token = tokenData.access_token;
      } catch (refreshError) {
        // 如果是 invalid_grant 错误，直接禁用账号
        if (refreshError.isInvalidGrant) {
          logger.error(`账号刷新token失败(invalid_grant)，禁用账号: cookie_id=${account.cookie_id}`);
          await accountService.updateAccountStatus(account.cookie_id, 0);
        }
        throw refreshError;
      }
    }

    const modelsUrl = config.api.modelsUrl;
    
    const requestHeaders = {
      'Host': config.api.host,
      'User-Agent': config.api.userAgent,
      'Authorization': `Bearer ${account.access_token}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip'
    };
    const requestBody = {};
    
    let response;
    let data;
    
    try {
      response = await fetch(modelsUrl, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(requestBody)
      });
      
      data = await response.json();
      
      if (!response.ok) {
        throw new ApiError(JSON.stringify(data), response.status, JSON.stringify(data));
      }
      
    } catch (error) {
      throw error;
    }
    
    // 更新配额信息
    if (data.models) {
      await quotaService.updateQuotasFromModels(account.cookie_id, data.models);
    }

    const models = data?.models || {};
    return {
      object: 'list',
      data: Object.keys(models).map(id => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'google'
      }))
    };
  }

  /**
   * 刷新cookie的quota（实时获取，使用两个projectId并叠加配额）
   * @param {string} cookie_id - Cookie ID
   * @param {string} access_token - Access Token
   * @returns {Promise<void>}
   */
  async refreshCookieQuota(cookie_id, access_token) {
    const modelsUrl = config.api.modelsUrl;
    
    try {
      // 获取账号信息以获取projectId
      const account = await accountService.getAccountByCookieId(cookie_id);
      if (!account) {
        logger.warn(`账号不存在: cookie_id=${cookie_id}`);
        return;
      }
      
      const requestHeaders = {
        'Host': config.api.host,
        'User-Agent': config.api.userAgent,
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip'
      };
      
      let modelsData = {};
      
      // 使用 project_id_0 获取配额
      try {
        const pid0 = account.project_id_0 || '';
        const response0 = await fetch(modelsUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify({ project: pid0 })
        });
        
        if (response0.ok) {
          const data0 = await response0.json();
          modelsData = data0.models || {};
        } else {
          logger.warn(`[配额刷新] project_id_0 获取失败: HTTP ${response0.status}`);
        }
      } catch (error) {
        logger.warn(`[配额刷新] project_id_0 获取配额失败: ${error.message}`);
      }
      
      // 更新到数据库
      if (Object.keys(modelsData).length > 0) {
        await quotaService.updateQuotasFromModels(cookie_id, modelsData);
      }
    } catch (error) {
      logger.warn(`刷新quota失败: cookie_id=${cookie_id}`, error.message);
    }
  }

  /**
   * 对话完成后更新配额
   * @param {string} cookie_id - Cookie ID
   * @param {string} model_name - 模型名称
   * @returns {Promise<number|null>} 更新后的quota值
   */
  async updateQuotaAfterCompletion(cookie_id, model_name) {
    const account = await accountService.getAccountByCookieId(cookie_id);
    if (!account) {
      logger.warn(`账号不存在: cookie_id=${cookie_id}`);
      return null;
    }

    await this.refreshCookieQuota(cookie_id, account.access_token);
    
    // 返回更新后的quota值
    const quotaInfo = await quotaService.getQuota(cookie_id, model_name);
    return quotaInfo ? quotaInfo.quota : null;
  }

  /**
   * 生成图片（使用多账号）
   * @param {Object} requestBody - 请求体
   * @param {string} user_id - 用户ID
   * @param {string} model_name - 模型名称
   * @param {Object} user - 用户对象
   * @param {Object} account - 账号对象（可选，如果不提供则自动获取）
   * @param {Array} excludeCookieIds - 要排除的cookie_id列表（用于重试时排除已失败的账号）
   * @returns {Promise<Object>} 图片生成响应
   */
  async generateImage(requestBody, user_id, model_name, user, account = null, excludeCookieIds = []) {
    // 如果没有提供 account，则获取一个
    if (!account) {
      account = await this.getAvailableAccount(user_id, model_name, user, excludeCookieIds);
    }
    
    // 获取请求前的配额信息
    let quotaBefore = null;
    try {
      const quotaInfo = await quotaService.getQuota(account.cookie_id, model_name);
      quotaBefore = quotaInfo ? parseFloat(quotaInfo.quota) : null;
      logger.info(`图片生成开始 - cookie_id=${account.cookie_id}, model=${model_name}, quota_before=${quotaBefore}`);
    } catch (error) {
      logger.warn('获取缓存配额失败:', error.message);
    }
    
    // 使用账号的 project_id_0
    if (account.project_id_0) {
      requestBody.project = account.project_id_0;
    }
    
    const url = config.api.url;
    
    const requestHeaders = {
      'Host': config.api.host,
      'User-Agent': config.api.userAgent,
      'Authorization': `Bearer ${account.access_token}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip'
    };

    
    let response;
    
    try {
      // 创建 AbortController 用于超时控制
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 600000); // 10分钟超时
      
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
      
      if (!response.ok) {
        const responseText = await response.text();
        
        if (response.status === 403) {
          logger.warn(`账号没有使用权限(403)，已禁用: cookie_id=${account.cookie_id}`);
          await accountService.updateAccountStatus(account.cookie_id, 0);
        }
        
        // 检查是否是400错误
        if (response.status === 400) {
          // 检查是否是配额耗尽错误，自动更换账号重试
          if (responseText.includes('quota') || responseText.includes('RESOURCE_EXHAUSTED')) {
            logger.warn(`[图片生成-400错误] 账号配额耗尽，尝试更换账号重试: cookie_id=${account.cookie_id}`);
            
            // 将当前账号加入排除列表
            const newExcludeList = [...excludeCookieIds, account.cookie_id];
            
            try {
              // 尝试获取新账号并重试
              const newAccount = await this.getAvailableAccount(user_id, model_name, user, newExcludeList);
              logger.info(`[图片生成] 已获取新账号，重试请求: new_cookie_id=${newAccount.cookie_id}`);
              
              // 更新 requestBody 中的 project
              if (newAccount.project_id_0) {
                requestBody.project = newAccount.project_id_0;
              }
              
              // 递归调用，使用新账号重试
              return await this.generateImage(requestBody, user_id, model_name, user, newAccount, newExcludeList);
            } catch (retryError) {
              // 如果没有更多可用账号，返回配额耗尽错误
              logger.error(`[图片生成] 所有账号配额已耗尽，无法重试: ${retryError.message}`);
              throw new ApiError('RESOURCE_EXHAUSTED', 429, 'RESOURCE_EXHAUSTED');
            }
          }
          // 检查是否是图片超过5MB的错误
          if (responseText.includes('image exceeds 5 MB maximum')) {
            logger.warn(`[图片生成-400错误] 图片超过5MB限制`);
            throw new ApiError('IMAGE_INPUT_EXCEEDED_MAXIMUM_5_MB', 400, 'IMAGE_INPUT_EXCEEDED_MAXIMUM_5_MB');
          }
          // 检查是否是 RESOURCE_PROJECT_INVALID 错误，禁用账号并换号重试
          if (responseText.includes('RESOURCE_PROJECT_INVALID')) {
            logger.warn(`[图片生成-400错误] RESOURCE_PROJECT_INVALID，禁用账号并尝试更换账号重试: cookie_id=${account.cookie_id}`);
            await accountService.updateAccountStatus(account.cookie_id, 0);
            
            // 将当前账号加入排除列表
            const newExcludeList = [...excludeCookieIds, account.cookie_id];
            
            try {
              // 尝试获取新账号并重试
              const newAccount = await this.getAvailableAccount(user_id, model_name, user, newExcludeList);
              logger.info(`[图片生成] 已获取新账号，重试请求: new_cookie_id=${newAccount.cookie_id}`);
              
              // 更新 requestBody 中的 project
              if (newAccount.project_id_0) {
                requestBody.project = newAccount.project_id_0;
              }
              
              // 递归调用，使用新账号重试
              return await this.generateImage(requestBody, user_id, model_name, user, newAccount, newExcludeList);
            } catch (retryError) {
              // 如果没有更多可用账号，返回错误
              logger.error(`[图片生成] 所有账号都不可用，无法重试: ${retryError.message}`);
              throw new ApiError('RESOURCE_PROJECT_INVALID', 400, 'RESOURCE_PROJECT_INVALID');
            }
          }
          // 检查是否是 INVALID_ARGUMENT 或 invalid_request_error 错误（请求参数问题，不应禁用账号）
          if (responseText.includes('INVALID_ARGUMENT') || responseText.includes('invalid_request_error')) {
            logger.warn(`[图片生成-400错误] 参数错误(INVALID_ARGUMENT/invalid_request_error)，不禁用账号: cookie_id=${account.cookie_id}, error=${responseText.substring(0, 200)}`);
            throw new ApiError(responseText, response.status, responseText);
          }
          // 其他400错误，禁用账号
          logger.warn(`账号请求失败(400)，已禁用: cookie_id=${account.cookie_id}, error=${responseText.substring(0, 200)}`);
          await accountService.updateAccountStatus(account.cookie_id, 0);
          throw new ApiError(responseText, response.status, responseText);
        }
        
        // 检查是否是429配额耗尽错误，自动更换账号重试
        if (response.status === 429 || responseText.includes('quota') || responseText.includes('RESOURCE_EXHAUSTED')) {
          logger.warn(`[图片生成-429错误] 账号配额耗尽，尝试更换账号重试: cookie_id=${account.cookie_id}`);
          
          // 将当前账号加入排除列表
          const newExcludeList = [...excludeCookieIds, account.cookie_id];
          
          try {
            // 尝试获取新账号并重试
            const newAccount = await this.getAvailableAccount(user_id, model_name, user, newExcludeList);
            logger.info(`[图片生成] 已获取新账号，重试请求: new_cookie_id=${newAccount.cookie_id}`);
            
            // 更新 requestBody 中的 project
            if (newAccount.project_id_0) {
              requestBody.project = newAccount.project_id_0;
            }
            
            // 递归调用，使用新账号重试
            return await this.generateImage(requestBody, user_id, model_name, user, newAccount, newExcludeList);
          } catch (retryError) {
            // 如果没有更多可用账号，返回配额耗尽错误
            logger.error(`[图片生成] 所有账号配额已耗尽，无法重试: ${retryError.message}`);
            throw new ApiError('RESOURCE_EXHAUSTED', 429, 'RESOURCE_EXHAUSTED');
          }
        }
        
        // 检查是否是500错误且包含 "Internal error encountered"
        if (response.status === 500 && responseText.includes('Internal error encountered')) {
          logger.error(`[图片生成-500错误] Internal error encountered，返回 ILLEGAL_PROMPT`);
          throw new ApiError('ILLEGAL_PROMPT', 500, 'ILLEGAL_PROMPT');
        }
        
        // 其他错误
        throw new ApiError(responseText, response.status, responseText);
      }
      
    } catch (error) {
      throw error;
    }

    // 解析响应 (处理 SSE 流式格式)
    const responseText = await response.text();
    const lines = responseText.split('\n');
    let collectedParts = [];
    let lastFinishReason = null;

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const jsonStr = line.slice(6);
        try {
          const chunk = JSON.parse(jsonStr);
          const parts = chunk.response?.candidates?.[0]?.content?.parts;
          if (parts) {
            collectedParts.push(...parts);
          }
          if (chunk.response?.candidates?.[0]?.finishReason) {
            lastFinishReason = chunk.response.candidates[0].finishReason;
          }
        } catch (e) {
          logger.warn(`图片生成响应解析失败: ${e.message}`);
        }
      }
    }

    // 构造标准的 Gemini 响应格式
    const data = {
      candidates: [
        {
          content: {
            parts: collectedParts,
            role: 'model'
          },
          finishReason: lastFinishReason || 'STOP'
        }
      ]
    };
    
    // 图片生成完成后，更新配额信息并记录消耗
    try {
      const quotaAfter = await this.updateQuotaAfterCompletion(account.cookie_id, model_name);
      
      // 记录配额消耗
      if (quotaBefore !== null && quotaAfter !== null) {
        let consumed = parseFloat(quotaBefore) - parseFloat(quotaAfter);
        
        // 如果消耗为负数，说明配额在请求期间重置了，记录消耗为0
        if (consumed < 0) {
          logger.info(`配额在请求期间重置，记录消耗为0 - quota_before=${quotaBefore}, quota_after=${quotaAfter}`);
          consumed = 0;
        }
        
        await quotaService.recordQuotaConsumption(
          user_id,
          account.cookie_id,
          model_name,
          quotaBefore,
          quotaAfter,
          account.is_shared
        );
        logger.info(`图片生成配额消耗已记录 - user_id=${user_id}, is_shared=${account.is_shared}, consumed=${consumed.toFixed(4)}`);
      } else {
        logger.warn(`无法记录图片生成配额消耗 - quotaBefore=${quotaBefore}, quotaAfter=${quotaAfter}`);
      }
    } catch (error) {
      logger.error('更新配额或记录消耗失败:', error.message, error.stack);
      // 不影响主流程，只记录错误
    }
    
    return data;
  }
}

const multiAccountClient = new MultiAccountClient();
export default multiAccountClient;
import redisService from './redis.service.js';
import logger from '../utils/logger.js';

/**
 * Thought Signature 管理服务
 *
 * 简化版：只存储单个 signature 字符串
 *
 * Gemini 的要求：
 * 1. 最后一条 model 消息必须有 thought: true
 * 2. 所有 toolCall 和 toolResponse 必须带 thoughtSignature: S
 *
 * 关键洞察：Gemini 不要求必须有思考文本！
 * 我们可以构造"空思考块"（只有 thought: true + thoughtSignature，没有 text）
 */
class SignatureService {
  constructor() {
    this.SIGNATURE_TTL = 7200; // 2小时过期（延长以支持长对话）
    this.KEY_PREFIX = 'thought_sig';
  }

  /**
   * 生成存储 key
   * 使用 user_id 作为 key，每个用户只存储最新的 signature
   * @param {string} user_id - 用户ID
   * @returns {string} Redis key
   */
  generateKey(user_id) {
    return `${this.KEY_PREFIX}:${user_id}`;
  }

  /**
   * 存储 thought signature
   * @param {string} user_id - 用户ID
   * @param {string} signature - signature 字符串
   */
  async storeSignature(user_id, signature) {
    if (!signature) {
      return;
    }

    const key = this.generateKey(user_id);
    
    try {
      await redisService.set(key, signature, this.SIGNATURE_TTL);
      logger.info(`已存储 thought signature: user_id=${user_id}, sig=${signature.substring(0, 20)}...`);
    } catch (error) {
      logger.error('存储 thought signature 失败:', error.message);
    }
  }

  /**
   * 检索 thought signature
   * @param {string} user_id - 用户ID
   * @returns {Promise<string|null>} signature 字符串或 null
   */
  async retrieveSignature(user_id) {
    const key = this.generateKey(user_id);
    
    try {
      const signature = await redisService.get(key);
      if (signature) {
        logger.info(`检索到 thought signature: user_id=${user_id}, sig=${signature.substring(0, 20)}...`);
        return signature;
      }
    } catch (error) {
      logger.error('检索 thought signature 失败:', error.message);
    }
    
    return null;
  }

  /**
   * 清除 thought signature
   * @param {string} user_id - 用户ID
   */
  async clearSignature(user_id) {
    const key = this.generateKey(user_id);
    
    try {
      await redisService.del(key);
      logger.info(`已清除 thought signature: user_id=${user_id}`);
    } catch (error) {
      logger.error('清除 thought signature 失败:', error.message);
    }
  }

  /**
   * 从响应中提取第一个 thought signature
   * @param {Array} parts - 响应的 parts 数组
   * @returns {string|null} signature 字符串或 null
   */
  extractSignatureFromResponse(parts) {
    if (!parts || !Array.isArray(parts)) {
      return null;
    }

    for (const part of parts) {
      // 提取任何带有 thoughtSignature 的 part
      if (part.thoughtSignature) {
        return part.thoughtSignature;
      }
    }
    
    return null;
  }

  /**
   * 检查消息中是否包含 tool_calls 或 tool 响应
   * 用于判断是否需要注入 signature
   * @param {Array} messages - OpenAI 格式的消息数组
   * @returns {boolean}
   */
  hasToolInteraction(messages) {
    if (!messages || !Array.isArray(messages)) {
      return false;
    }

    for (const msg of messages) {
      // 检查是否有 tool_calls
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return true;
      }
      // 检查是否有 tool 响应
      if (msg.role === 'tool') {
        return true;
      }
    }
    
    return false;
  }
}

const signatureService = new SignatureService();
export default signatureService;
import { getUserDetailsWithAvatar } from '../../lib/dbHelpers';

// Интерфейсы для типизации входных данных
export interface MessageData {
    dialog_id?: string;
    group_id?: string;
    sender_id: string;
    content: string;
    mentions?: string[];
    fileIds?: string[];
    replied_to_message_id?: string;
}

export interface NotificationData {
    user_id: string;
    type: string;
    content: string;
    related_dialog_id?: string;
    related_group_id?: string;
}

export interface ContactAddedData {
    user_id: string;
    contact_id: string;
}

export interface TypingData {
    dialog_id?: string;
    group_id?: string;
    user_id: string;
}

export interface MarkMessagesAsReadData {
    dialog_id?: string;
    group_id?: string;
    message_ids: string[];
}

export interface UpdateMyEventStatusData {
    eventId: string;
    status: string;
}

// Лимиты для защиты от спама
export const MESSAGE_RATE_LIMIT = {
    maxMessages: 10,
    windowMs: 60 * 1000, // 1 минута
};
export const userMessageTimestamps = new Map<string, number[]>();

// Кэш для userDetails
export const userDetailsCache = new Map<string, { username: string; avatarPath: string | null; timestamp: number }>();
export const CACHE_TTL = 5 * 60 * 1000; // 5 минут

export const socketTaskRooms = new Map<string, Set<string>>();

// Валидация UUID
export const isValidUUID = (str: string): boolean => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
};

// Проверка лимитов сообщений
export const checkRateLimit = (userId: string): boolean => {
    const now = Date.now();
    const timestamps = userMessageTimestamps.get(userId) || [];
    const recentTimestamps = timestamps.filter(ts => now - ts < MESSAGE_RATE_LIMIT.windowMs);
    
    if (recentTimestamps.length >= MESSAGE_RATE_LIMIT.maxMessages) {
        return false;
    }
    
    recentTimestamps.push(now);
    userMessageTimestamps.set(userId, recentTimestamps);
    return true;
};

// Мемоизация getUserDetailsWithAvatar
export const getCachedUserDetails = async (userId: string): Promise<{ username: string; avatarPath: string | null }> => {
    const cached = userDetailsCache.get(userId);
    const now = Date.now();
    
    if (cached && now - cached.timestamp < CACHE_TTL) {
        return { username: cached.username, avatarPath: cached.avatarPath };
    }
    
    const details = await getUserDetailsWithAvatar(userId);
    if (!details.username) {
        throw new Error('User not found');
    }
    
    userDetailsCache.set(userId, {
        username: details.username,
        avatarPath: details.avatarPath,
        timestamp: now,
    });
    
    return { username: details.username, avatarPath: details.avatarPath };
};
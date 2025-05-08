import knex from '../lib/knex';
import type { Knex as KnexType } from 'knex';

export const isUserParticipant = async (userId: string, conversationId: string, dbClient?: KnexType | KnexType.Transaction): Promise<boolean> => {
    const queryRunner = dbClient || knex;
    try {
        const participant = await queryRunner('conversation_participants')
            .where({
                user_id: userId,
                conversation_id: conversationId
            })
            .select('user_id') // Select something small
            .first();
        return !!participant;
    } catch (error) {
        console.error(`Error checking participation for user ${userId} in conversation ${conversationId}:`, error);
        return false; // Assume not participant on error
    }
};

// === Добавленные хелперы ===

// Из conversationController.ts
export const fetchPinnedMessageIds = async (conversationId: string, dbClient?: KnexType | KnexType.Transaction): Promise<string[]> => {
    const queryRunner = dbClient || knex;
    try {
        const result = await queryRunner('pinned_messages')
            .select('message_id')
            .where('conversation_id', conversationId)
            .orderBy('pinned_at', 'desc');
        return result.map(row => row.message_id);
    } catch (error) {
        console.error(`Error fetching pinned messages for conversation ${conversationId}:`, error);
        return []; 
    }
};

// Из conversationController.ts
export const fetchAllParticipantsByConversationIdForMessages = async (conversation_id: string, dbClient?: KnexType | KnexType.Transaction) => {
    const queryRunner = dbClient || knex;
    try {
        // Возвращаем объекты с id, username, avatarPath
        const participants = await queryRunner('conversation_participants as cp')
            .select('u.id', 'u.username', 'ua.file_path as avatarPath') 
            .join('users as u', 'u.id', 'cp.user_id')
            .leftJoin('user_avatars as ua', 'u.id', 'ua.user_id')
            .where('cp.conversation_id', conversation_id);
        return participants; // participants будет массивом объектов { id: string, username: string, avatarPath: string | null } или пустой массив
    } catch (error) {
        console.error(`Error fetching participants for messages (conversation ${conversation_id}):`, error);
        return []; 
    }
};

// Из taskController.ts
export const getUserDetailsWithAvatar = async (userId: string | null | undefined, dbClient?: KnexType | KnexType.Transaction): Promise<{ id: string | null | undefined, username: string | null, avatarPath: string | null }> => {
    if (!userId) return { id: userId, username: null, avatarPath: null };
    const queryRunner = dbClient || knex;
    try {
        const userResult = await queryRunner('users as u')
            .select('u.username', 'ua.file_path as avatarPath')
            .leftJoin('user_avatars as ua', 'u.id', 'ua.user_id')
            .where('u.id', userId)
            .first();
        
        return {
            id: userId,
            username: userResult ? userResult.username : null,
            avatarPath: userResult ? userResult.avatarPath : null
        };
    } catch (error) {
        console.error(`Error fetching username/avatar for user ${userId}:`, error);
        return { id: userId, username: null, avatarPath: null };
    }
}; 
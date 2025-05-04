import { json } from "stream/consumers";
import pool from "../models/db";
import { Request, Response } from "express";
import * as socketService from '../services/socketService';
import path from 'path';
import fs from 'fs';

// Remove SERVER_BASE_URL and getAbsoluteUrl
// const HOST = process.env.HOST || 'localhost';
// const PORT = process.env.PORT || 6000;
// const SERVER_BASE_URL = `http://${HOST}:${PORT}`;

// Function to construct absolute URL from relative path - REMOVED
// const getAbsoluteUrl = (relativePath: string | null): string | null => {
//     return relativePath ? `${SERVER_BASE_URL}${relativePath}` : null;
// };

// Тип для данных из req.user
interface AuthenticatedUser {
    id: string;
    username?: string;
}

// Helper function to check user participation
const isUserParticipant = async (userId: string, conversationId: string): Promise<boolean> => {
    const result = await pool.query(
        'SELECT 1 FROM conversation_participants WHERE user_id = $1 AND conversation_id = $2',
        [userId, conversationId]
    );
    return result.rowCount !== null && result.rowCount > 0;
};

// Helper function to fetch pinned message IDs for a conversation
const fetchPinnedMessageIds = async (conversationId: string): Promise<string[]> => {
    try {
        const result = await pool.query(
            'SELECT message_id FROM pinned_messages WHERE conversation_id = $1 ORDER BY pinned_at DESC',
            [conversationId]
        );
        return result.rows.map(row => row.message_id);
    } catch (error) {
        console.error(`Error fetching pinned messages for conversation ${conversationId}:`, error);
        return []; // Return empty array on error
    }
};

// --- NEW HELPER --- Fetch full conversation details (returns absolute URLs)
const fetchFullConversationDetails = async (conversationId: string): Promise<any | null> => {
    console.log(`Fetching full details for conversation: ${conversationId}`);
    try {
        const result = await pool.query(
            `
            WITH participants_info AS (
                SELECT
                    cp.conversation_id,
                    json_agg(
                        json_build_object(
                            'user_id', u.id,
                            'username', u.username,
                            'email', u.email,
                            'is_online', u.is_online,
                            'avatarPath', ua.file_path -- Participant relative avatar path
                        ) ORDER BY u.username
                    ) AS participants
                FROM conversation_participants cp
                JOIN users u ON u.id = cp.user_id
                LEFT JOIN user_avatars ua ON u.id = ua.user_id
                WHERE cp.conversation_id = $1
                GROUP BY cp.conversation_id
            ),
            admin_details AS (
                SELECT
                    u.id as admin_id,
                    u.username as admin_username,
                    ua.file_path as "adminAvatarPath" -- Admin relative avatar path
                FROM users u
                LEFT JOIN user_avatars ua ON u.id = ua.user_id
                WHERE u.id = (SELECT admin_id FROM conversations WHERE id = $1)
            )
            SELECT
                c.id AS conversation_id,
                CASE
                    WHEN c.is_group_chat THEN c.name
                    WHEN NOT c.is_group_chat THEN (
                        SELECT u_dialog.username FROM conversation_participants cp_dialog JOIN users u_dialog ON u_dialog.id = cp_dialog.user_id WHERE cp_dialog.conversation_id = c.id AND cp_dialog.user_id != c.admin_id LIMIT 1
                    )
                    ELSE c.name
                END AS conversation_name,
                c.is_group_chat,
                c.name AS group_name,
                c.avatar_path AS "groupAvatarPath", -- Group relative avatar path
                ad.admin_id,
                ad.admin_username,
                ad."adminAvatarPath",
                COALESCE(pi.participants, '[]'::json) AS participants,
                c.created_at::text AS conversation_created_at,
                (SELECT COALESCE(array_agg(pm.message_id ORDER BY pm.pinned_at DESC), '{}'::uuid[]) FROM pinned_messages pm WHERE pm.conversation_id = c.id) AS pinned_message_ids
            FROM conversations c
            LEFT JOIN participants_info pi ON pi.conversation_id = c.id
            LEFT JOIN admin_details ad ON true
            WHERE c.id = $1;
            `,
            [conversationId]
        );
        if (result.rowCount === 0) { return null; }

        const conversationDetails = result.rows[0];
        // Format and construct absolute URLs -> NO LONGER NEEDED
        const formattedDetails = {
            ...conversationDetails,
            conversation_created_at: new Date(conversationDetails.conversation_created_at).toISOString(),
            // Return participants directly with avatarPath
            // participants: conversationDetails.participants?.map((p: any) => ({ ...p, avatarUrl: getAbsoluteUrl(p.avatarPath), avatarPath: undefined })) || [],
            // Return relative paths directly
            // groupAvatarUrl: getAbsoluteUrl(conversationDetails.groupAvatarPath),
            // adminAvatarUrl: getAbsoluteUrl(conversationDetails.adminAvatarPath),
            // groupAvatarPath: undefined, // Keep original path
            // adminAvatarPath: undefined // Keep original path
        };
        // Return raw details with relative paths
        return formattedDetails; // Note: field names are already groupAvatarPath, adminAvatarPath, participants (with avatarPath inside)
    } catch (error) {
        console.error(`Error fetching full conversation details for ${conversationId}:`, error);
        return null;
    }
};
// --- END NEW HELPER ---

export const fetchAllConversationsByUserId = async (req: Request, res: Response) => {
    let userId: string | null = null;
    if (req.user) {
        userId = (req.user as AuthenticatedUser).id;
    } else {
        console.warn("Attempt to fetch conversations without authentication.");
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }

    console.log(`Получение чатов для пользователя: ${userId}`);

    try {
        const result = await pool.query(
            `
            WITH dialog_names AS (
                SELECT
                    c.id AS conversation_id,
                    CASE
                        WHEN c.name = 'dialog' THEN (
                            SELECT u.username
                            FROM conversation_participants cp2
                            JOIN users u ON u.id = cp2.user_id
                            WHERE cp2.conversation_id = c.id
                            AND cp2.user_id != $1
                            LIMIT 1
                        )
                        ELSE c.name
                    END AS conversation_name
                FROM conversations c
            ),
            last_messages AS (
                SELECT DISTINCT ON (m.conversation_id)
                    m.conversation_id,
                    m.content,
                    m.created_at,
                    m.sender_id,
                    m.sender_username,
                    sender_avatar.file_path AS sender_avatar_path, -- Get relative path
                    m.is_forwarded,
                    m.forwarded_from_username
                FROM messages m
                LEFT JOIN user_avatars sender_avatar ON m.sender_id = sender_avatar.user_id
                ORDER BY m.conversation_id, m.created_at DESC
            ),
            participants_info AS (
                SELECT
                    cp.conversation_id,
                    json_agg(
                        json_build_object(
                            'user_id', u.id,
                            'username', u.username,
                            'email', u.email,
                            'is_online', u.is_online,
                            'avatarPath', COALESCE(ua.file_path, NULL) -- Added participant avatarPath
                        ) ORDER BY u.username
                    ) AS participants
                FROM conversation_participants cp
                JOIN users u ON u.id = cp.user_id
                LEFT JOIN user_avatars ua ON u.id = ua.user_id -- Join for participant avatars
                GROUP BY cp.conversation_id
            ),
            unread_counts AS (
                SELECT
                    m.conversation_id,
                    COUNT(m.id) AS unread_count
                FROM messages m
                JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id AND cp.user_id = $1
                LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.user_id = cp.user_id
                WHERE m.sender_id != $1 AND mr.message_id IS NULL
                GROUP BY m.conversation_id
            ),
             pinned_ids AS (
                 SELECT
                     conversation_id,
                     array_agg(message_id ORDER BY pinned_at DESC) as pinned_message_ids
                 FROM pinned_messages
                 GROUP BY conversation_id
            )
            SELECT
                c.id AS conversation_id,
                dn.conversation_name,
                c.is_group_chat,
                c.name AS group_name,
                c.avatar_path AS "groupAvatarPath", -- Get relative path
                admin_user.username AS admin_name,
                admin_avatar.file_path AS "adminAvatarPath", -- Get relative path
                c.admin_id,
                lm.content AS last_message,
                lm.created_at AS last_message_time,
                lm.sender_id AS last_message_sender_id,
                lm.sender_avatar_path AS "lastMessageSenderAvatarPath", -- Get relative path
                CASE
                    WHEN lm.is_forwarded THEN '[Переслано от ' || COALESCE(lm.forwarded_from_username, 'Unknown') || '] ' || lm.content
                    ELSE lm.content
                END AS last_message_content_preview,
                lm.sender_username AS last_message_sender_username,
                lm.is_forwarded AS last_message_is_forwarded,
                lm.forwarded_from_username AS last_message_forwarded_from,
                COALESCE(uc.unread_count, 0) AS unread_count,
                cp.is_muted,
                cp.last_read_timestamp::text AS last_read_timestamp,
                COALESCE(p_ids.pinned_message_ids, '{}'::uuid[]) AS pinned_message_ids,
                pi.participants, -- Participants info (with relative paths)
                c.created_at AS conversation_created_at
            FROM conversations c
            JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1
            JOIN dialog_names dn ON dn.conversation_id = c.id
            LEFT JOIN users admin_user ON admin_user.id = c.admin_id
            LEFT JOIN user_avatars admin_avatar ON admin_user.id = admin_avatar.user_id
            LEFT JOIN last_messages lm ON lm.conversation_id = c.id
            LEFT JOIN unread_counts uc ON uc.conversation_id = c.id
            LEFT JOIN participants_info pi ON pi.conversation_id = c.id
            LEFT JOIN pinned_ids p_ids ON p_ids.conversation_id = c.id
            ORDER BY lm.created_at DESC NULLS LAST
            `,
            [userId]
        );

        // Map results, format dates, and construct absolute URLs -> NO LONGER NEEDED
        const formattedResults = result.rows.map(row => ({
            ...row,
            last_message_time: row.last_message_time ? new Date(row.last_message_time).toISOString() : null,
            last_read_timestamp: row.last_read_timestamp ? new Date(row.last_read_timestamp).toISOString() : null,
            conversation_created_at: new Date(row.conversation_created_at).toISOString(),
            // Return participants directly with avatarPath
            // participants: row.participants?.map((p: any) => ({ ...p, avatarUrl: getAbsoluteUrl(p.avatarPath), avatarPath: undefined })) || [],
            // Return relative paths directly
            // groupAvatarUrl: getAbsoluteUrl(row.groupAvatarPath),
            // adminAvatarUrl: getAbsoluteUrl(row.adminAvatarPath),
            // lastMessageSenderAvatarUrl: getAbsoluteUrl(row.lastMessageSenderAvatarPath),
            // groupAvatarPath: undefined, // Keep original path
            // adminAvatarPath: undefined,
            // lastMessageSenderAvatarPath: undefined,
            
        }));

        console.log(`Чаты успешно получены для пользователя: ${userId}`);
        res.json(formattedResults);
    } catch (e) {
        const error = e as Error;
        console.error(`Ошибка при получении чатов для пользователя: ${userId} - ${error.message}`);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
};

export const createDialog = async (req: Request, res: Response): Promise<any> => {
    let userId = null;
    if (req.user) {
        userId = req.user.id;
    }
    const { contact_id } = req.body;

    try {
        // Проверяем существование диалога
        const existingDialog = await pool.query(
            `
            SELECT id FROM conversations
            WHERE id IN (
                SELECT conversation_id FROM conversation_participants
                WHERE user_id = $1
            )
            AND id IN (
                SELECT conversation_id FROM conversation_participants
                WHERE user_id = $2
            )
            AND is_group_chat = FALSE
            LIMIT 1;
            `,
            [userId, contact_id]
        );

        if (existingDialog.rowCount !== null && existingDialog.rowCount > 0) {
            return res.json({ conversation_id: existingDialog.rows[0].id });
        }

        // Создаем новый диалог
        const newDialog = await pool.query(
            `
            INSERT INTO conversations (name, is_group_chat, admin_id)
            VALUES ('dialog', FALSE, $1)
            RETURNING id;
            `,
            [userId]
        );

        const conversation_id = newDialog.rows[0].id;

        // Добавляем участников
        await pool.query(
            `
            INSERT INTO conversation_participants (conversation_id, user_id)
            VALUES ($1, $2), ($1, $3);
            `,
            [conversation_id, userId, contact_id]
        );

        res.json({ conversation_id });
    } catch (error) {
        console.error('Ошибка при создании диалога:', error);
        res.status(500).json({ error: 'Не удалось создать диалог' });
    }
};

export const createGroupChat = async (req: Request, res: Response): Promise<any> => {
    let userId = null;
    if (req.user) {
        userId = req.user.id;
    }
    const { name, participants } = req.body;

    try {
        // Проверяем существование группового чата с таким именем
        const existingChat = await pool.query(
            `
            SELECT id FROM conversations
            WHERE name = $1 AND is_group_chat = TRUE
            LIMIT 1;
            `,
            [name]
        );

        if (existingChat.rowCount !== null && existingChat.rowCount > 0) {
            return res.status(409).json({ error: 'Групповой чат с таким именем уже существует' });
        }

        // Создаем новый групповой чат
        const newChat = await pool.query(
            `
            INSERT INTO conversations (name, is_group_chat, admin_id)
            VALUES ($1, TRUE, $2)
            RETURNING id;
            `,
            [name, userId]
        );

        const conversation_id = newChat.rows[0].id;

        // Добавляем создателя и всех участников
        const allParticipants = [userId, ...participants];
        // Удаляем дубликаты из массива участников
        const uniqueParticipants = Array.from(new Set(allParticipants));
        
        // Создаем массив значений для вставки
        const values = uniqueParticipants.map(participantId => `('${conversation_id}', '${participantId}')`).join(',');
        
        await pool.query(
            `
            INSERT INTO conversation_participants (conversation_id, user_id)
            VALUES ${values};
            `
        );

        res.status(201).json({ conversation_id });
    } catch (error) {
        console.error('Ошибка при создании группового чата:', error);
        res.status(500).json({ error: 'Не удалось создать групповой чат' });
    }
};

export const addParticipantToConversation = async (req: Request, res: Response): Promise<any> => {
    const { conversation_id, user_id: participant_id } = req.body;
    let requestingUserId = null;
    if (req.user) {
        requestingUserId = req.user.id;
    } else {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log(`User ${requestingUserId} attempting to add participant ${participant_id} to conversation ${conversation_id}`);

    try {
        const conversationResult = await pool.query(
            `SELECT admin_id, is_group_chat FROM conversations WHERE id = $1`,
            [conversation_id]
        );

        if (conversationResult.rowCount === 0) {
            console.log('Conversation not found');
            return res.status(404).json({ error: 'Conversation not found' });
        }

        const { admin_id, is_group_chat } = conversationResult.rows[0];

        if (!is_group_chat) {
            console.log('Cannot add participant to a non-group chat');
            return res.status(400).json({ error: 'Cannot add participant to a dialog' });
        }

        if (requestingUserId !== admin_id) {
            console.log('Permission denied: User is not the admin');
            return res.status(403).json({ error: 'Forbidden: Only the admin can add participants' });
        }
        
        const userExists = await pool.query('SELECT id FROM users WHERE id = $1', [participant_id]);
        if (userExists.rowCount === 0) {
            console.log('User to add not found');
            return res.status(404).json({ error: 'User to add not found' });
        }

        const participantExists = await pool.query(
            `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
            [conversation_id, participant_id]
        );

        if (participantExists.rowCount !== null && participantExists.rowCount > 0) {
             console.log('Participant already exists in the conversation');
             return res.status(409).json({ error: 'Participant already exists in this conversation' });
        }

        await pool.query(
            `
            INSERT INTO conversation_participants (conversation_id, user_id)
            VALUES ($1, $2);
            `,
            [conversation_id, participant_id]
        );

        console.log(`Participant ${participant_id} added successfully to conversation ${conversation_id} by user ${requestingUserId}`);

        // --- Emit conversationUpdated --- 
        const updatedDetails = await fetchFullConversationDetails(conversation_id);
        if (updatedDetails) {
            socketService.emitToRoom(conversation_id, 'conversationUpdated', updatedDetails);
            console.log(`Sent conversationUpdated after adding participant to room ${conversation_id}`);
        }
        // ---

        res.status(201).json({ message: 'Participant added successfully' }); 
    } catch (error) {
        console.error('Error adding participant to conversation:', error);
        res.status(500).json({ error: 'Failed to add participant to conversation' });
    }
};

export const removeParticipantFromConversation = async (req: Request, res: Response): Promise<any> => {
    const { conversation_id, participant_id } = req.body;
    let requestingUserId = null;
    if (req.user) {
        requestingUserId = req.user.id;
    } else {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log(`User ${requestingUserId} attempting to remove participant ${participant_id} from conversation ${conversation_id}`);

    try {
        const conversationResult = await pool.query(
            `SELECT admin_id, is_group_chat FROM conversations WHERE id = $1`,
            [conversation_id]
        );

        if (conversationResult.rowCount === 0) {
            console.log('Conversation not found');
            return res.status(404).json({ error: 'Conversation not found' });
        }

        const { admin_id, is_group_chat } = conversationResult.rows[0];

        if (!is_group_chat) {
            console.log('Cannot remove participant from a non-group chat');
            return res.status(400).json({ error: 'Cannot remove participant from a dialog' });
        }

        if (requestingUserId !== admin_id) {
            console.log('Permission denied: User is not the admin');
            return res.status(403).json({ error: 'Forbidden: Only the admin can remove participants' });
        }

        if (participant_id === admin_id) {
            console.log('Attempted to remove the admin');
            return res.status(400).json({ error: 'Bad Request: Cannot remove the group admin' });
        }

        const result = await pool.query(
            `DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
            [conversation_id, participant_id]
        );

        if (result.rowCount === 0) {
            console.log('Participant not found in this conversation');
            return res.status(404).json({ error: 'Participant not found in this conversation' }); 
        }

        console.log(`Participant ${participant_id} removed successfully from conversation ${conversation_id} by user ${requestingUserId}`);
        
        // --- Emit conversationUpdated --- 
        const updatedDetails = await fetchFullConversationDetails(conversation_id);
        if (updatedDetails) {
            socketService.emitToRoom(conversation_id, 'conversationUpdated', updatedDetails);
            console.log(`Sent conversationUpdated after removing participant to room ${conversation_id}`);
        }
        // ---

        // Also emit userLeftGroup to the removed participant's personal room?
        const leavePayload = { conversation_id: conversation_id, user_id: participant_id };
        socketService.emitToUser(participant_id, 'userRemovedFromGroup', leavePayload); // New event name
        console.log(`Sent userRemovedFromGroup event to user ${participant_id}`);

        res.status(200).json({ message: 'Participant removed successfully' });
    } catch (error) {
        console.error('Error removing participant from conversation:', error);
        res.status(500).json({ error: 'Failed to remove participant from conversation' });
    }
};

export const updateConversationName = async (req: Request, res: Response): Promise<any> => {
    const { conversation_id, conversation_name } = req.body;
    let requestingUserId = null;
    if (req.user) {
        requestingUserId = req.user.id;
    } else {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!conversation_id || !conversation_name || typeof conversation_name !== 'string' || conversation_name.trim() === '') {
        return res.status(400).json({ error: 'Bad Request: conversation_id and a non-empty conversation_name string are required in the body' });
    }

    console.log(`User ${requestingUserId} attempting to rename conversation ${conversation_id} to "${conversation_name}"`);

    try {
        const conversationResult = await pool.query(
            `SELECT admin_id, is_group_chat FROM conversations WHERE id = $1`,
            [conversation_id]
        );

        if (conversationResult.rowCount === 0) {
            console.log('Conversation not found');
            return res.status(404).json({ error: 'Conversation not found' });
        }

        const { admin_id, is_group_chat } = conversationResult.rows[0];

        if (!is_group_chat) {
            console.log('Cannot rename a non-group chat');
            return res.status(400).json({ error: 'Bad Request: Cannot rename a dialog' });
        }

        if (requestingUserId !== admin_id) {
            console.log('Permission denied: User is not the admin');
            return res.status(403).json({ error: 'Forbidden: Only the admin can rename the group' });
        }

        const updateResult = await pool.query(
            `UPDATE conversations SET name = $1 WHERE id = $2 RETURNING name`,
            [conversation_name.trim(), conversation_id]
        );
        
        if (updateResult.rowCount === 0) {
             console.error('Failed to update conversation name after checks');
             return res.status(500).json({ error: 'Failed to update conversation name' });
        }

        console.log(`Conversation ${conversation_id} renamed successfully to "${updateResult.rows[0].name}" by user ${requestingUserId}`);

        // --- Emit conversationUpdated --- 
        const updatedDetails = await fetchFullConversationDetails(conversation_id);
        if (updatedDetails) {
            socketService.emitToRoom(conversation_id, 'conversationUpdated', updatedDetails);
            console.log(`Sent conversationUpdated after rename to room ${conversation_id}`);
        }
        // ---

        res.status(200).json({ conversation_name: updateResult.rows[0].name });
    } catch (error) {
        console.error('Error updating conversation name:', error);
        res.status(500).json({ error: 'Failed to update conversation name' });
    }
};

export const fetchAllParticipantsByConversationId = async (req: Request, res: Response): Promise<any> => {
    const { conversationId } = req.params;
    console.log(`Fetching participants for conversation: ${conversationId}`);
    try {
        const result = await pool.query(
            `SELECT u.id as user_id, u.username, u.email, u.is_online, ua.file_path AS "avatarPath"
             FROM conversation_participants cp JOIN users u ON u.id = cp.user_id LEFT JOIN user_avatars ua ON u.id = ua.user_id
             WHERE cp.conversation_id = $1 ORDER BY u.username ASC`,
            [conversationId]
        );
        // Return results directly with avatarPath
        // const participants = result.rows.map(p => ({ ...p, avatarUrl: getAbsoluteUrl(p.avatarPath), avatarPath: undefined }));
        res.json(result.rows);
    } catch (error) {
        console.error(`Error fetching participants for conversation ${conversationId}:`, error);
        res.status(500).json({ error: 'Failed to fetch participants' });
    }
};

export const fetchAllParticipantsByConversationIdForMessages = async (conversation_id: string) => {
    console.log(`Fetching participants for messages in conversation: ${conversation_id}`);
    try {
        const result = await pool.query(
            `SELECT u.id as user_id, u.username, u.email, u.is_online, ua.file_path AS "avatarPath"
             FROM conversation_participants cp JOIN users u ON u.id = cp.user_id LEFT JOIN user_avatars ua ON u.id = ua.user_id
             WHERE cp.conversation_id = $1 ORDER BY u.username ASC`,
            [conversation_id]
        );
        console.log(`Fetched ${result.rowCount} participants for messages in conversation: ${conversation_id}`);
        // Return results directly with avatarPath
        // const participants = result.rows.map(p => ({ ...p, avatarUrl: getAbsoluteUrl(p.avatarPath), avatarPath: undefined }));
        return result.rows;
    } catch (error) {
        console.error(`Error fetching participants for messages in conversation ${conversation_id}:`, error);
        return null;
    }
};

// Функция для отметки чата как прочитанного/непрочитанного (Новая логика с message_reads)
export const markConversationReadUnread = async (req: Request, res: Response) => {
    // Получаем conversationId из ТЕЛА запроса
    const { conversationId, mark_as_unread } = req.body; // boolean
    const userId = (req.user as AuthenticatedUser).id;

    // Валидация conversationId из тела
    if (!conversationId || typeof conversationId !== 'string') {
        res.status(400).json({ error: 'Необходимо указать conversationId в теле запроса' });
        return;
    }
    if (typeof mark_as_unread !== 'boolean') {
        res.status(400).json({ error: 'Необходимо указать поле mark_as_unread (true/false)' });
        return;
    }

    console.log(`User ${userId} marking conversation ${conversationId} as ${mark_as_unread ? 'unread' : 'read'}`);

    const client = await pool.connect(); // Используем клиент для транзакции (если понадобится)

    try {
        // 0. Проверяем, является ли пользователь участником
        const participantCheck = await client.query(
            'SELECT 1 FROM conversation_participants WHERE user_id = $1 AND conversation_id = $2',
            [userId, conversationId]
        );
        if (participantCheck.rowCount === 0) {
            res.status(404).json({ error: 'Чат не найден или вы не являетесь участником' });
            return;
        }

        if (mark_as_unread === false) { // Пометить как прочитанный
            // 1. Найти все ID сообщений в чате, отправленные не текущим пользователем
            const messagesToRead = await client.query(
                `SELECT id FROM messages WHERE conversation_id = $1 AND sender_id != $2`,
                [conversationId, userId]
            );
            const messageIdsToRead = messagesToRead.rows.map(row => row.id);

            // 2. Добавить записи в message_reads для всех этих сообщений
            if (messageIdsToRead.length > 0) {
                const values = messageIdsToRead.map(id => `('${id}', '${userId}', NOW())`).join(',');
                await client.query(
                    `INSERT INTO message_reads (message_id, user_id, read_at) VALUES ${values}
                     ON CONFLICT (message_id, user_id) DO NOTHING`
                );
                 console.log(`Marked ${messageIdsToRead.length} messages as read for user ${userId} in conv ${conversationId}`);
            }

        } else { // Пометить как непрочитанный
            // 1. Удалить все записи о прочтении для пользователя в этом чате
            const deleteResult = await client.query(
                `DELETE FROM message_reads
                 WHERE user_id = $1 AND message_id IN (SELECT id FROM messages WHERE conversation_id = $2)`,
                [userId, conversationId]
            );
             console.log(`Marked conversation ${conversationId} as unread for user ${userId}. Deleted ${deleteResult.rowCount} read records.`);
        }

        // 3. Пересчитать актуальное количество непрочитанных сообщений
        const unreadCountResult = await client.query(
             `SELECT COUNT(*)
              FROM messages m
              LEFT JOIN message_reads mr ON m.id = mr.message_id AND mr.user_id = $1
              WHERE m.conversation_id = $2 AND m.sender_id != $1 AND mr.message_id IS NULL`,
             [userId, conversationId]
         );
        const actualUnreadCount = parseInt(unreadCountResult.rows[0].count, 10);

        // 4. Получить текущий статус is_muted
        const muteStatusResult = await client.query(
            `SELECT is_muted FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
            [conversationId, userId]
        );
        const currentMuteStatus = muteStatusResult.rows[0]?.is_muted ?? false; // Default to false if somehow not found

        // 5. Отправить событие conversationUpdated пользователю с актуальными данными
        const updatePayload = {
             id: conversationId,
             unread_count: actualUnreadCount, // Отправляем актуальный счетчик
             is_muted: currentMuteStatus
             // last_read_timestamp больше не используется здесь
        };
        socketService.emitToUser(userId, 'conversationUpdated', updatePayload);
        console.log(`Sent conversationUpdated to user ${userId} for conversation ${conversationId} with unread_count: ${actualUnreadCount}`);

        // 6. Вернуть актуальный статус в ответе API
        res.status(200).json({
            id: conversationId,
            unread_count: actualUnreadCount,
            is_muted: currentMuteStatus
        });

    } catch (error) {
        console.error(`Error marking conversation ${conversationId} read/unread for user ${userId}:`, error);
        res.status(500).json({ error: 'Ошибка сервера при обновлении статуса прочтения чата' });
    } finally {
        client.release(); // Всегда освобождаем клиент
    }
};

// Функция для включения/выключения уведомлений (Mute)
export const muteConversation = async (req: Request, res: Response) => {
    // Получаем conversationId из ТЕЛА запроса
    const { conversationId, is_muted } = req.body; // boolean
    const userId = (req.user as AuthenticatedUser).id;

    // Валидация conversationId из тела
    if (!conversationId || typeof conversationId !== 'string') {
        res.status(400).json({ error: 'Необходимо указать conversationId в теле запроса' });
        return;
    }
    if (typeof is_muted !== 'boolean') {
        res.status(400).json({ error: 'Необходимо указать поле is_muted (true/false)' });
        return;
    }

    console.log(`User ${userId} setting mute status to ${is_muted} for conversation ${conversationId}`);

    try {
        const updateResult = await pool.query(
            `UPDATE conversation_participants
             SET is_muted = $1
             WHERE conversation_id = $2 AND user_id = $3
             RETURNING is_muted`, // Возвращаем новое значение для подтверждения
            [is_muted, conversationId, userId]
        );

        if (updateResult.rowCount === 0) {
            console.warn(`User ${userId} not found in conversation ${conversationId} or conversation does not exist.`);
            res.status(404).json({ error: 'Чат не найден или вы не являетесь участником' });
            return;
        }

        const newMuteStatus = updateResult.rows[0].is_muted;

        // Отправляем событие conversationUpdated пользователю
        const updatePayload = {
            id: conversationId,
            is_muted: newMuteStatus
        };
        socketService.emitToUser(userId, 'conversationUpdated', updatePayload);
         console.log(`Sent conversationUpdated (mute) to user ${userId} for conversation ${conversationId}`);


        res.status(200).json(updatePayload); // Возвращаем ID и новый статус

    } catch (error) {
        console.error(`Error setting mute status for conversation ${conversationId} for user ${userId}:`, error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
};


// Функция для выхода из группы или удаления диалога
export const leaveOrDeleteConversation = async (req: Request, res: Response) => {
    // Получаем conversationId из ТЕЛА запроса
    const { conversationId } = req.body;
    const userId = (req.user as AuthenticatedUser).id;

    // Валидация conversationId из тела
    if (!conversationId || typeof conversationId !== 'string') {
        res.status(400).json({ error: 'Необходимо указать conversationId в теле запроса' });
        return;
    }

    // Определяем, это выход из группы или удаление чата по пути роутера
    // req.path для /leave будет '/leave', для /delete будет '/delete'
    const isLeavingGroup = req.path.endsWith('/leave');
    const isDeletingConversation = req.path.endsWith('/delete');

    console.log(`User ${userId} attempting to ${isLeavingGroup ? 'leave' : (isDeletingConversation ? 'delete' : 'unknown action on')} conversation ${conversationId} (from body)`);

    try {
        // Проверяем существование чата и является ли пользователь участником
         const convInfo = await pool.query(
             `SELECT c.id, c.is_group_chat, cp.user_id IS NOT NULL AS is_participant
              FROM conversations c
              LEFT JOIN conversation_participants cp ON c.id = cp.conversation_id AND cp.user_id = $2
              WHERE c.id = $1`,
             [conversationId, userId]
         );

         if (convInfo.rowCount === 0) {
             console.warn(`Conversation ${conversationId} not found.`);
             res.status(404).json({ error: 'Чат не найден' });
             return;
         }

         const { id, is_group_chat, is_participant } = convInfo.rows[0];

         if (!is_participant) {
             console.warn(`User ${userId} is not a participant of conversation ${conversationId}.`);
             res.status(403).json({ error: 'Вы не являетесь участником этого чата' });
             return;
         }

         if (isLeavingGroup) { // Выход из группы
             if (!is_group_chat) {
                 console.warn(`User ${userId} tried to leave a non-group chat ${conversationId} using the group leave endpoint.`);
                 res.status(400).json({ error: 'Нельзя выйти из диалога этим способом. Используйте удаление чата.' });
                 return;
             }

             // Удаляем пользователя из участников
             await pool.query(
                 `DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
                 [conversationId, userId]
             );
             console.log(`User ${userId} left group ${conversationId}.`);

             // --- Emit conversationUpdated to remaining participants --- 
             const updatedDetails = await fetchFullConversationDetails(conversationId);
             if (updatedDetails) {
                 socketService.emitToRoom(conversationId, 'conversationUpdated', updatedDetails);
                 console.log(`Sent conversationUpdated after user left to room ${conversationId}`);
             }
             // ---

             // Отправляем событие покинувшему пользователю, что он вышел
             const leavePayloadSelf = { id: conversationId };
             socketService.emitToUser(userId, 'conversationLeft', leavePayloadSelf); // New specific event for self
             console.log(`Sent conversationLeft event to user ${userId}`);

         } else { // Удаление диалога (или группы целиком, если используется этот эндпоинт)
             if (is_group_chat) {
                 // Пока неясно, должен ли DELETE /conversations/:id удалять группу для всех
                 // или только скрывать ее для пользователя. Предположим, удаляет для всех (требует прав админа?)
                 // TODO: Добавить проверку прав администратора для удаления группы
                 console.warn(`Attempting to delete group chat ${conversationId} via DELETE /conversations/:id. Implement admin check.`);
                 // Пока запретим удаление группы этим методом
                 res.status(403).json({ error: 'Удаление группы пока не поддерживается или требует прав администратора' });
                 return;
             }

             // Удаление диалога (Hard Delete)
             await pool.query(
                 `DELETE FROM conversations WHERE id = $1`,
                 [conversationId]
             );
             console.log(`User ${userId} deleted dialog ${conversationId}.`);

             // Отправляем событие пользователю, который удалил чат
             const deletePayload = { id: conversationId };
             socketService.emitToUser(userId, 'conversationDeleted', deletePayload);
             console.log(`Sent conversationDeleted event to user ${userId}`);
         }

        res.status(204).send();

    } catch (error) {
        console.error(`Error during ${isLeavingGroup ? 'leaving' : (isDeletingConversation ? 'deleting' : 'unknown action on')} conversation ${conversationId} for user ${userId}:`, error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
};

// --- Pinning Logic ---
export const togglePinMessage = async (req: Request, res: Response): Promise<void> => {
    // Get IDs from request body instead of params
    const { conversationId, messageId } = req.body;
    let userId: string | null = null;

    // Basic validation for body parameters
    if (!conversationId || typeof conversationId !== 'string' || !messageId || typeof messageId !== 'string') {
        res.status(400).json({ error: 'Необходимо указать conversationId и messageId в теле запроса' });
        return;
    }

    if (req.user) {
        userId = (req.user as AuthenticatedUser).id;
    } else {
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }

    console.log(`User ${userId} attempting to toggle pin for message ${messageId} in conversation ${conversationId}`);

    try {
        // 1. Verify user is a participant
        const participant = await isUserParticipant(userId, conversationId);
        if (!participant) {
            console.warn(`User ${userId} is not a participant of conversation ${conversationId}.`);
            res.status(403).json({ error: 'Вы не являетесь участником этого чата' });
            return;
        }

        // 2. Verify message exists in the conversation
        const messageExists = await pool.query(
            'SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2',
            [messageId, conversationId]
        );
        if (messageExists.rowCount === 0) {
            console.warn(`Message ${messageId} not found in conversation ${conversationId}.`);
            res.status(404).json({ error: 'Сообщение не найдено в этом чате' });
            return;
        }

        // 3. Check if already pinned
        const existingPin = await pool.query(
            'SELECT 1 FROM pinned_messages WHERE conversation_id = $1 AND message_id = $2',
            [conversationId, messageId]
        );

        // 4. Perform toggle action
        if (existingPin.rowCount !== null && existingPin.rowCount > 0) {
            // Unpin
            await pool.query(
                'DELETE FROM pinned_messages WHERE conversation_id = $1 AND message_id = $2',
                [conversationId, messageId]
            );
            console.log(`Message ${messageId} unpinned by user ${userId} in conversation ${conversationId}`);
        } else {
            // Pin
            await pool.query(
                'INSERT INTO pinned_messages (conversation_id, message_id, pinned_by_user_id, pinned_at) VALUES ($1, $2, $3, NOW())',
                [conversationId, messageId, userId]
            );
             console.log(`Message ${messageId} pinned by user ${userId} in conversation ${conversationId}`);
        }

        // 5. Fetch the updated list of pinned message IDs
        const updatedPinnedIds = await fetchPinnedMessageIds(conversationId);

        // 6. Emit WebSocket event
        const eventPayload = {
            id: conversationId,
            pinned_message_ids: updatedPinnedIds
        };
        socketService.emitToRoom(conversationId, 'conversationUpdated', eventPayload);
         console.log(`Emitted 'conversationUpdated' to room ${conversationId} with updated pinned messages.`);

        // 7. Send response
        res.status(200).json({
            success: true,
            pinned_message_ids: updatedPinnedIds
        });

    } catch (error) {
        console.error(`Error toggling pin for message ${messageId} by user ${userId}:`, error);
        res.status(500).json({ error: 'Ошибка сервера при закреплении/откреплении сообщения' });
    }
};
// --- End Pinning Logic ---

// --- Group Avatar Logic ---

// Helper to delete old group avatar file
const findAndDeleteOldGroupAvatar = async (conversationId: string): Promise<void> => {
    try {
        const oldAvatarResult = await pool.query(
            'SELECT avatar_path FROM conversations WHERE id = $1',
            [conversationId]
        );
        if (oldAvatarResult.rows.length > 0 && oldAvatarResult.rows[0].avatar_path) {
            const oldFilePathRelative = oldAvatarResult.rows[0].avatar_path;
            const oldFilePathAbsolute = path.join(__dirname, '..', '..', 'uploads', 'group_avatars', path.basename(oldFilePathRelative));
            if (fs.existsSync(oldFilePathAbsolute)) {
                fs.unlink(oldFilePathAbsolute, (err) => {
                    if (err) {
                        console.error(`Error deleting old group avatar file ${oldFilePathAbsolute}:`, err);
                    } else {
                        console.log(`Old group avatar file ${oldFilePathAbsolute} deleted.`);
                    }
                });
            }
        }
    } catch (error) {
        console.error(`Error finding/deleting old group avatar for conversation ${conversationId}:`, error);
    }
};

// Upload/Update Group Avatar
export const uploadGroupAvatar = async (req: Request, res: Response): Promise<any> => {
    const { conversationId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'No avatar file uploaded.' });
    }

    const { filename } = req.file;
    const relativePath = `/uploads/group_avatars/${filename}`; // Relative path for DB
    // const absoluteUrl = getAbsoluteUrl(relativePath); // Absolute URL for response - REMOVED

    console.log(`User ${userId} attempting to upload group avatar for conversation ${conversationId}: ${filename}`);

    try {
        // 1. Check conversation exists, is group, and user is admin
        const convResult = await pool.query('SELECT admin_id, is_group_chat FROM conversations WHERE id = $1', [conversationId]);
        if (convResult.rowCount === 0) {
            fs.unlinkSync(req.file.path); // Delete uploaded file
            return res.status(404).json({ error: 'Conversation not found' });
        }
        const { admin_id, is_group_chat } = convResult.rows[0];
        if (!is_group_chat) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Cannot set avatar for a dialog' });
        }
        if (admin_id !== userId) {
            fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: 'Forbidden: Only admin can change group avatar' });
        }

        // 2. Delete old file from filesystem
        await findAndDeleteOldGroupAvatar(conversationId);

        // 3. Update database with RELATIVE path
        const updateResult = await pool.query(
            'UPDATE conversations SET avatar_path = $1 WHERE id = $2 RETURNING avatar_path',
            [relativePath, conversationId]
        );

        console.log(`Group avatar for conversation ${conversationId} updated successfully. Path: ${relativePath}`);

        // 4. Fetch details (which will construct absolute URLs) and emit
        const updatedDetails = await fetchFullConversationDetails(conversationId);
        if (updatedDetails) {
            socketService.emitToRoom(conversationId, 'conversationUpdated', updatedDetails);
            console.log(`Sent conversationUpdated after group avatar update to room ${conversationId}`);
        }

        // 5. Return success response with RELATIVE PATH
        res.status(200).json({ message: 'Group avatar updated successfully', groupAvatarPath: relativePath });

    } catch (error: any) {
        console.error('Error uploading group avatar:', error);
        // Clean up uploaded file on error
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlink(req.file.path, (unlinkErr) => {
                if (unlinkErr) console.error(`Error deleting orphaned group upload ${req.file?.path}:`, unlinkErr);
            });
        }
        res.status(500).json({ error: 'Failed to upload group avatar', details: error.message });
    }
};

// Delete Group Avatar
export const deleteGroupAvatar = async (req: Request, res: Response): Promise<any> => {
    const { conversationId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log(`User ${userId} attempting to delete group avatar for conversation ${conversationId}`);

    try {
        // 1. Check conversation exists, is group, and user is admin
        const convResult = await pool.query('SELECT admin_id, is_group_chat, avatar_path FROM conversations WHERE id = $1', [conversationId]);
        if (convResult.rowCount === 0) {
            return res.status(404).json({ error: 'Conversation not found' });
        }
        const { admin_id, is_group_chat, avatar_path } = convResult.rows[0];
        if (!is_group_chat) {
            return res.status(400).json({ error: 'Dialogs do not have avatars' });
        }
        if (admin_id !== userId) {
            return res.status(403).json({ error: 'Forbidden: Only admin can delete group avatar' });
        }
        if (!avatar_path) {
            return res.status(404).json({ error: 'Group does not have an avatar to delete' });
        }

        // 2. Delete file from filesystem
        const filePathAbsolute = path.join(__dirname, '..', '..', 'uploads', 'group_avatars', path.basename(avatar_path));
        if (fs.existsSync(filePathAbsolute)) {
            fs.unlink(filePathAbsolute, (err) => {
                if (err) {
                    // Log error but proceed with DB update
                    console.error(`Error deleting group avatar file ${filePathAbsolute}:`, err);
                } else {
                    console.log(`Group avatar file ${filePathAbsolute} deleted.`);
                }
            });
        } else {
             console.warn(`Group avatar file not found at ${filePathAbsolute}, skipping deletion.`);
        }

        // 3. Update database (set path to NULL)
        await pool.query(
            'UPDATE conversations SET avatar_path = NULL WHERE id = $1',
            [conversationId]
        );

        console.log(`Group avatar path removed for conversation ${conversationId}`);

        // 4. Emit conversationUpdated event
        const updatedDetails = await fetchFullConversationDetails(conversationId);
        if (updatedDetails) {
            socketService.emitToRoom(conversationId, 'conversationUpdated', updatedDetails);
            console.log(`Sent conversationUpdated after group avatar deletion to room ${conversationId}`);
        }

        // 5. Return success response
        res.status(200).json({ message: 'Group avatar deleted successfully' });

    } catch (error: any) {
        console.error('Error deleting group avatar:', error);
        res.status(500).json({ error: 'Failed to delete group avatar', details: error.message });
    }
};
// --- End Group Avatar Logic ---

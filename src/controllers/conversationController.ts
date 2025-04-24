import { json } from "stream/consumers";
import pool from "../models/db";
import { Request, Response } from "express";
import * as socketService from '../services/socketService';

// Тип для данных из req.user
interface AuthenticatedUser {
    id: string;
}

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
                SELECT DISTINCT ON (conversation_id)
                    conversation_id,
                    content,
                    created_at,
                    sender_id,
                    sender_username
                FROM messages
                ORDER BY conversation_id, created_at DESC
            ),
            participants_info AS (
                SELECT
                    cp.conversation_id,
                    json_agg(
                        json_build_object(
                            'user_id', u.id,
                            'username', u.username,
                            'email', u.email,
                            'is_online', u.is_online
                        ) ORDER BY u.username
                    ) AS participants
                FROM conversation_participants cp
                JOIN users u ON u.id = cp.user_id
                GROUP BY cp.conversation_id
            ),
            unread_counts AS (
                SELECT
                    m.conversation_id,
                    COUNT(m.id) AS unread_count
                FROM messages m
                JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id AND cp.user_id = $1
                WHERE m.sender_id != $1
                  AND m.created_at > COALESCE(cp.last_read_timestamp, '1970-01-01'::timestamp)
                GROUP BY m.conversation_id
            )
            SELECT
                c.id AS conversation_id,
                dn.conversation_name,
                c.is_group_chat,
                c.name AS group_name,
                admin_user.username AS admin_name,
                c.admin_id,
                lm.content AS last_message,
                lm.created_at AS last_message_time,
                lm.sender_id AS last_message_sender_id,
                lm.sender_username AS last_message_sender_username,
                COALESCE(uc.unread_count, 0) AS unread_count,
                cp.is_muted,
                cp.last_read_timestamp::text AS last_read_timestamp,
                pi.participants,
                c.created_at AS conversation_created_at
            FROM conversations c
            JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1
            JOIN dialog_names dn ON dn.conversation_id = c.id
            LEFT JOIN users admin_user ON admin_user.id = c.admin_id
            LEFT JOIN last_messages lm ON lm.conversation_id = c.id
            LEFT JOIN unread_counts uc ON uc.conversation_id = c.id
            LEFT JOIN participants_info pi ON pi.conversation_id = c.id
            ORDER BY lm.created_at DESC NULLS LAST
            `,
            [userId]
        );

        const formattedResults = result.rows.map(row => ({
            ...row,
            last_message_time: row.last_message_time ? new Date(row.last_message_time).toISOString() : null,
            last_read_timestamp: row.last_read_timestamp ? new Date(row.last_read_timestamp).toISOString() : null,
            conversation_created_at: new Date(row.conversation_created_at).toISOString()
        }));

        console.log(`Чаты успешно получены для пользователя: ${userId} (с подсчетом unread по timestamp)`);
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
        res.status(200).json({ conversation_name: updateResult.rows[0].name });
    } catch (error) {
        console.error('Error updating conversation name:', error);
        res.status(500).json({ error: 'Failed to update conversation name' });
    }
};

export const fetchAllParticipantsByConversationId = async (req: Request, res: Response): Promise<any> => {
    const { conversation_id } = req.body;

    console.log(`Fetching participants for conversation: ${conversation_id}`);

    try {
        const result = await pool.query(
            `
            SELECT u.id AS user_id, u.username, u.email
            FROM conversation_participants cp
            JOIN users u ON u.id = cp.user_id
            WHERE cp.conversation_id = $1
            ORDER BY u.username ASC
            `,
            [conversation_id]
        );

        console.log(`Participants fetched successfully for conversation: ${conversation_id}`);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching participants:', error);
        res.status(500).json({ error: 'Failed to fetch participants' });
    }
};

export const fetchAllParticipantsByConversationIdForMessages = async (conversation_id: string) => {
    console.log(`Получение участников для разговора: ${conversation_id}`);

    try {
        const result = await pool.query(
            `
            SELECT u.id AS user_id, u.username, u.email
            FROM conversation_participants cp
            JOIN users u ON u.id = cp.user_id
            WHERE cp.conversation_id = $1
            ORDER BY u.username ASC
            `,
            [conversation_id]
        );

        console.log(`Участники успешно получены для разговора: ${conversation_id}`);
        return result.rows;
    } catch (error) {
        console.error('Ошибка при получении участников:', error);
        throw error;
    }
};

// Функция для отметки чата как прочитанного/непрочитанного (Вариант 2 из ТЗ)
export const markConversationReadUnread = async (req: Request, res: Response) => {
    const { conversationId } = req.params;
    const { mark_as_unread } = req.body; // boolean
    const userId = (req.user as AuthenticatedUser).id;

    if (typeof mark_as_unread !== 'boolean') {
        res.status(400).json({ error: 'Необходимо указать поле mark_as_unread (true/false)' });
        return;
    }

    console.log(`User ${userId} marking conversation ${conversationId} as ${mark_as_unread ? 'unread' : 'read'}`);

    try {
        let newTimestamp: Date | string | null = null;
        let estimatedUnreadCount: number | null = null;

        if (mark_as_unread === false) { // Пометить как прочитанный
            // Устанавливаем текущее время как время последнего прочтения
            newTimestamp = new Date();
            estimatedUnreadCount = 0;
        } else { // Пометить как непрочитанный
            // Найдем время ПРЕДПОСЛЕДНЕГО сообщения или чуть раньше последнего
             const lastMessageRes = await pool.query(
                 `SELECT created_at
                  FROM messages
                  WHERE conversation_id = $1
                  ORDER BY created_at DESC
                  LIMIT 1 OFFSET 1`, // Берем второе сообщение с конца
                 [conversationId]
             );

             if (lastMessageRes.rowCount !== null && lastMessageRes.rowCount > 0) {
                 // Устанавливаем время прочтения на момент предпоследнего сообщения
                 newTimestamp = lastMessageRes.rows[0].created_at;
             } else {
                  // Если есть только одно сообщение или ни одного, делаем timestamp NULL
                  // или можно установить timestamp очень старый
                  newTimestamp = null; // Помечаем как "не читал совсем"
             }
            estimatedUnreadCount = 1; // Предполагаем, что как минимум 1 сообщение будет непрочитано
        }

        // Обновляем last_read_timestamp для участника
        const updateResult = await pool.query(
            `UPDATE conversation_participants
             SET last_read_timestamp = $1
             WHERE conversation_id = $2 AND user_id = $3`,
            [newTimestamp, conversationId, userId]
        );

        if (updateResult.rowCount === 0) {
            // Возможно, пользователь не участник этого чата
             console.warn(`User ${userId} not found in conversation ${conversationId} or conversation does not exist.`);
             // Можно вернуть 404 или 403
             res.status(404).json({ error: 'Чат не найден или вы не являетесь участником' });
             return;
        }

        // Отправляем событие conversationUpdated пользователю
        // Здесь мы отправляем предполагаемое количество непрочитанных,
        // клиенту может потребоваться пересчитать точное значение при получении
        const updatePayload = {
             id: conversationId,
             // unread_count: estimatedUnreadCount // Раскомментировать, если клиент ожидает это поле
             // Можно также передать last_read_timestamp, если клиенту это нужно
             last_read_timestamp: newTimestamp ? (newTimestamp instanceof Date ? newTimestamp.toISOString() : new Date(newTimestamp).toISOString()) : null
         };
        socketService.emitToUser(userId, 'conversationUpdated', updatePayload);
        console.log(`Sent conversationUpdated to user ${userId} for conversation ${conversationId}`);

        // В ответе возвращаем estimatedUnreadCount или просто OK
        res.status(200).json({
            id: conversationId,
            // unread_count: estimatedUnreadCount // Если клиент ожидает это
        });

    } catch (error) {
        console.error(`Error marking conversation ${conversationId} read/unread for user ${userId}:`, error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
};

// Функция для включения/выключения уведомлений (Mute)
export const muteConversation = async (req: Request, res: Response) => {
    const { conversationId } = req.params;
    const { is_muted } = req.body; // boolean
    const userId = (req.user as AuthenticatedUser).id;

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
    const { conversationId } = req.params;
    const userId = (req.user as AuthenticatedUser).id;
    // Определяем, это выход из группы или удаление чата
    const isLeavingGroup = req.path.includes('/participants/me');

    console.log(`User ${userId} attempting to ${isLeavingGroup ? 'leave' : 'delete'} conversation ${conversationId}`);

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

             // Отправляем событие остальным участникам
             const leavePayload = { conversation_id: conversationId, user_id: userId };
             // Отправляем всем КРОМЕ покинувшего пользователя (он и так знает)
             // Получение ID сокета покинувшего пользователя не требуется, т.к. emitToRoom исключает отправителя,
             // но здесь нет 'отправителя' в контексте API. Лучше отправить всем в комнату.
             socketService.emitToRoom(conversationId, 'userLeftGroup', leavePayload);
             console.log(`Sent userLeftGroup event to room ${conversationId}`);

             // TODO: Возможно, нужно назначить нового админа, если вышел админ? (Требует доп. логики)
             // TODO: Возможно, добавить системное сообщение в чат?

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
        console.error(`Error during ${isLeavingGroup ? 'leaving' : 'deleting'} conversation ${conversationId} for user ${userId}:`, error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
};

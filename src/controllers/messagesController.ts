import { Request, Response } from 'express';
import { PoolClient } from 'pg'; // Import PoolClient for transaction
import pool from '../models/db';
import * as socketService from '../services/socketService'; // Импортируем socketService

interface AuthenticatedUser {
    id: string;
    username: string; 
}

// Добавляем новые поля в запрос
export const fetchAllMessagesByConversationId = async (req: Request, res: Response): Promise<void> => {
    // Get conversation_id from request body
    const { conversation_id } = req.body;
    // Get limit and offset from query parameters
    const limit = parseInt(req.query.limit as string || '50', 10);
    const offset = parseInt(req.query.offset as string || '0', 10);

    // Validate conversation_id from body
    if (!conversation_id || typeof conversation_id !== 'string') {
        res.status(400).json({ error: 'Необходимо указать conversation_id в теле запроса' });
        return;
    }

    let userId: string | null = null;
    if (req.user) {
        userId = (req.user as AuthenticatedUser).id;
    } else {
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }

    console.log(`Получение сообщений для разговора: ${conversation_id} (из тела), user: ${userId}, limit: ${limit}, offset: ${offset}`);

    try {
        // 1. Verify user is a participant of the conversation
        const participant = await isUserParticipant(userId, conversation_id);
        if (!participant) {
            console.warn(`User ${userId} attempted to access conversation ${conversation_id} without being a participant.`);
            res.status(403).json({ error: 'Доступ запрещен: Вы не являетесь участником этого чата' });
            return;
        }

        // 2. Fetch messages with pagination
        const messagesResult = await pool.query(
            `
            WITH message_files AS (
                SELECT
                    message_id,
                    json_agg(
                        json_build_object(
                            'id', f.id,
                            'file_name', f.file_name,
                            'file_path', f.file_path,
                            'file_type', f.file_type,
                            'file_size', f.file_size,
                            'created_at', f.created_at::text,
                            'download_url', '/api/files/download/' || f.id::text
                        ) ORDER BY f.created_at
                    ) as files
                FROM files f
                GROUP BY message_id
            ),
            message_reads_agg AS (
                 SELECT
                    message_id,
                    json_agg(
                        json_build_object(
                            'contact_id', u.id,
                            'username', u.username,
                            'email', u.email,
                            'read_at', mr.read_at::text,
                            'avatarPath', ua.file_path -- Reader relative avatar path
                        ) ORDER BY mr.read_at
                    ) as read_by_users
                FROM message_reads mr
                JOIN users u ON u.id = mr.user_id
                LEFT JOIN user_avatars ua ON u.id = ua.user_id
                GROUP BY message_id
            )
            SELECT
                m.id,
                m.content,
                m.sender_id,
                m.sender_username,
                sender_avatar.file_path AS "senderAvatarPath", -- Sender relative avatar path
                m.conversation_id,
                m.created_at::text AS created_at,
                m.is_edited,
                m.replied_to_message_id,
                replied_msg.sender_username AS replied_to_sender_username,
                CASE
                    WHEN replied_msg.content IS NOT NULL THEN LEFT(replied_msg.content, 50) || CASE WHEN LENGTH(replied_msg.content) > 50 THEN '...' ELSE '' END
                    WHEN replied_file.file_name IS NOT NULL THEN 'Файл: ' || replied_file.file_name
                    ELSE NULL
                END AS replied_to_content_preview,
                m.is_forwarded,
                m.forwarded_from_user_id,
                m.forwarded_from_username,
                m.original_message_id,
                CASE
                    WHEN $2::UUID IS NOT NULL THEN EXISTS (
                        SELECT 1
                        FROM message_reads mr
                        WHERE mr.message_id = m.id
                        AND mr.user_id = $2::UUID
                    )
                    ELSE FALSE
                END AS is_read_by_current_user,
                 COALESCE(mra.read_by_users, '[]'::json) AS read_by_users,
                COALESCE(mf.files, '[]'::json) AS files
            FROM messages m
            LEFT JOIN user_avatars sender_avatar ON m.sender_id = sender_avatar.user_id
            LEFT JOIN message_files mf ON mf.message_id = m.id
            LEFT JOIN message_reads_agg mra ON mra.message_id = m.id
            LEFT JOIN messages replied_msg ON replied_msg.id = m.replied_to_message_id
            LEFT JOIN (SELECT message_id, file_name FROM files LIMIT 1) replied_file ON replied_file.message_id = replied_msg.id
            WHERE m.conversation_id = $1
            ORDER BY m.created_at DESC
            LIMIT $3
            OFFSET $4
            `,
            [conversation_id, userId, limit, offset] // Parameters order: conversation_id, userId, limit, offset
        );

        // 3. Format results
        const formattedMessages = messagesResult.rows.map(msg => ({
            ...msg,
            created_at: new Date(msg.created_at).toISOString(),
            // Return relative path directly
            // senderAvatarUrl: getAbsoluteUrl(msg.senderAvatarPath),
            read_by_users: msg.read_by_users.map((reader: any) => ({ 
                ...reader,
                read_at: new Date(reader.read_at).toISOString(),
                // Return relative path directly
                // avatarUrl: getAbsoluteUrl(reader.avatarPath),
                // avatarPath: undefined // Keep original path
            })),
            files: msg.files.map((file: any) => ({ ...file, created_at: new Date(file.created_at).toISOString() })), // File paths are already relative
            is_unread: !msg.is_read_by_current_user && msg.sender_id !== userId,
            // senderAvatarPath: undefined // Keep original path
        }));

        // 4. << REMOVED AUTOMATIC MARK AS READ LOGIC >>
        // Fetching messages should NOT automatically mark them as read.
        // Client should use 'markMessagesAsRead' event or similar mechanism.

        console.log(`Сообщения успешно получены для разговора: ${conversation_id} (limit: ${limit}, offset: ${offset})`);
        // Send messages (usually newest first due to ORDER BY DESC)
        res.json(formattedMessages);

    } catch (err) {
        console.error(`Не удалось получить сообщения для разговора ${conversation_id} - ${(err as Error).message}`);
        res.status(500).json({ error: 'Не удалось получить сообщения' });
    }
};

// Обновляем saveMessage, добавляем repliedToMessageId
export const saveMessage = async (
    conversationId: string,
    senderId: string,
    content: string,
    mentions: string[] = [],
    fileIds?: string[], // Array of file IDs
    repliedToMessageId?: string // Новый параметр
) => {
    console.log(`Сохранение сообщения для разговора: ${conversationId}, отправитель: ${senderId}, ответ на: ${repliedToMessageId || 'нет'}`);

    // Проверка, существует ли сообщение, на которое отвечают (в том же чате)
    if (repliedToMessageId) {
        const checkReplyMsg = await pool.query(
            'SELECT id FROM messages WHERE id = $1 AND conversation_id = $2',
            [repliedToMessageId, conversationId]
        );
        if (checkReplyMsg.rowCount === 0) {
            console.error(`Ошибка: Сообщение ${repliedToMessageId} для ответа не найдено в разговоре ${conversationId}`);
            throw new Error('Сообщение, на которое вы отвечаете, не найдено в этом чате.');
        }
    }

    try {
        // Начинаем транзакцию
        await pool.query('BEGIN');

        // Сохраняем сообщение с replied_to_message_id
        const messageResult = await pool.query(
            `
            INSERT INTO messages (conversation_id, sender_id, content, replied_to_message_id)
            VALUES ($1, $2, $3, $4)
            RETURNING id, created_at -- Возвращаем только id и created_at
            `,
            [conversationId, senderId, content, repliedToMessageId || null] // Передаем null, если нет ответа
        );
        const savedMessageId = messageResult.rows[0].id;
        const savedMessageCreatedAt = messageResult.rows[0].created_at;

        // Если есть файлы, связываем их с сообщением
        if (fileIds && fileIds.length > 0) {
            for (const fileId of fileIds) {
            await pool.query(
                `UPDATE files SET message_id = $1 WHERE id = $2`,
                [savedMessageId, fileId]
            );
            }
        }

        // Отмечаем сообщение как прочитанное для отправителя
        await pool.query(
            `INSERT INTO message_reads (message_id, user_id, read_at) VALUES ($1, $2, NOW()) ON CONFLICT (message_id, user_id) DO NOTHING`,
            [savedMessageId, senderId]
        );

        // Добавляем упоминания, если они есть
        if (mentions.length > 0) {
            const mentionValues = mentions.map(mentionedUserId =>
                `('${savedMessageId}', '${mentionedUserId}', NOW())`
            ).join(',');
            await pool.query(`INSERT INTO message_mentions (message_id, user_id, created_at) VALUES ${mentionValues} ON CONFLICT (message_id, user_id) DO NOTHING`);
        }

        // Подтверждаем транзакцию
        await pool.query('COMMIT');

        // Получаем полную информацию о СОХРАНЕННОМ сообщении для отправки через WebSocket
        const fullMessageResult = await pool.query(
             `
             WITH message_files AS (
                 SELECT
                     message_id,
                     json_agg(
                         json_build_object(
                             'id', f.id,
                             'file_name', f.file_name,
                             'file_path', f.file_path,
                             'file_type', f.file_type,
                             'file_size', f.file_size,
                             'created_at', f.created_at::text,
                             'download_url', '/api/files/download/' || f.id::text
                         ) ORDER BY f.created_at
                     ) as files
                 FROM files f
                 GROUP BY message_id
             ),
             message_reads_agg AS (
                  SELECT
                     message_id,
                     json_agg(
                         json_build_object(
                             'contact_id', u.id,
                             'username', u.username,
                             'email', u.email,
                             'read_at', mr.read_at::text,
                             'avatarPath', ua.file_path -- Reader relative avatar path
                         ) ORDER BY mr.read_at
                     ) as read_by_users
                 FROM message_reads mr
                 JOIN users u ON u.id = mr.user_id
                 LEFT JOIN user_avatars ua ON u.id = ua.user_id
                 GROUP BY message_id
             )
             SELECT
                 m.id,
                 m.content,
                 m.sender_id,
                 m.sender_username,
                 sender_avatar.file_path AS "senderAvatarPath", -- Sender relative avatar path
                 m.conversation_id,
                 m.created_at::text AS created_at,
                 m.is_edited,
                 m.replied_to_message_id,
                 replied_msg.sender_username AS replied_to_sender_username,
                 CASE
                    WHEN replied_msg.content IS NOT NULL THEN LEFT(replied_msg.content, 50) || CASE WHEN LENGTH(replied_msg.content) > 50 THEN '...' ELSE '' END
                    WHEN replied_file.file_name IS NOT NULL THEN 'Файл: ' || replied_file.file_name
                    ELSE NULL
                 END AS replied_to_content_preview,
                 m.is_forwarded,
                 m.forwarded_from_user_id,
                 m.forwarded_from_username,
                 m.original_message_id,
                 -- For the sender, the message is always considered read
                 TRUE AS is_read_by_current_user,
                 COALESCE(mra.read_by_users, '[]'::json) AS read_by_users,
                 COALESCE(mf.files, '[]'::json) AS files
             FROM messages m
             LEFT JOIN user_avatars sender_avatar ON m.sender_id = sender_avatar.user_id
             LEFT JOIN message_files mf ON mf.message_id = m.id
             LEFT JOIN message_reads_agg mra ON mra.message_id = m.id
             LEFT JOIN messages replied_msg ON replied_msg.id = m.replied_to_message_id
             LEFT JOIN (SELECT message_id, file_name FROM files LIMIT 1) replied_file ON replied_file.message_id = replied_msg.id
             WHERE m.id = $1
             `,
            [savedMessageId]
        );

        if (fullMessageResult.rowCount === 0) {
            // Should not happen, but handle gracefully
            console.error(`Не удалось получить полную информацию о сохраненном сообщении ${savedMessageId}`);
            throw new Error('Не удалось получить детали сообщения после сохранения.');
        }

        // Format full message and construct absolute URLs for WebSocket payload
        const dbMessage = fullMessageResult.rows[0];
        const fullMessage = {
             ...dbMessage,
             created_at: new Date(dbMessage.created_at).toISOString(),
             // Return relative path directly
             // senderAvatarUrl: getAbsoluteUrl(dbMessage.senderAvatarPath),
             read_by_users: dbMessage.read_by_users.map((reader: any) => ({ 
                ...reader, 
                read_at: new Date(reader.read_at).toISOString(),
                // Return relative path directly
                // avatarUrl: getAbsoluteUrl(reader.avatarPath),
                // avatarPath: undefined // Keep original path
            })),
             files: dbMessage.files.map((file: any) => ({ ...file, created_at: new Date(file.created_at).toISOString() })), // File paths already relative
             // senderAvatarPath: undefined // Keep original path
         };

        console.log(`Сообщение ${savedMessageId} успешно сохранено и получено для WebSocket`);
        return fullMessage; // Return formatted message with absolute URLs

    } catch (err) {
        // Откатываем транзакцию в случае ошибки
        await pool.query('ROLLBACK');
        console.error(`Не удалось сохранить сообщение - ${(err as Error).message}`);
        throw new Error(`Не удалось сохранить сообщение: ${(err as Error).message}`);
    }
};
// --- Edit Message --- (Uses helper to fetch full details)
export const editMessage = async (req: Request, res: Response): Promise<void> => {
    const { messageId, content } = req.body;
    const user = req.user as AuthenticatedUser;

    // Validation
     if (!user || !user.id) {
         res.status(401).json({ error: 'Пользователь не аутентифицирован' });
         return;
     }
    if (!messageId || typeof messageId !== 'string') {
        res.status(400).json({ error: 'Необходимо указать messageId' });
        return;
    }
    if (content === undefined || content === null || typeof content !== 'string') {
        res.status(400).json({ error: 'Необходимо указать content (текст сообщения)' });
        return;
    }

    console.log(`Попытка редактирования сообщения ${messageId} пользователем ${user.id}`);

    const client = await pool.connect();
    try { // Added try block
         await client.query('BEGIN');

        // 1. Check ownership and get conversation ID
        const messageCheck = await client.query(
            'SELECT sender_id, conversation_id FROM messages WHERE id = $1',
            [messageId]
        );
        if (messageCheck.rowCount === 0) {
            await client.query('ROLLBACK');
                 res.status(404).json({ error: 'Сообщение не найдено' });
                 return;
        }
        const { sender_id, conversation_id } = messageCheck.rows[0];
        if (sender_id !== user.id) {
            await client.query('ROLLBACK');
                 res.status(403).json({ error: 'Вы не можете редактировать это сообщение' });
                 return;
        }

        // 2. Update content and edited flag
        await client.query(
            `UPDATE messages SET content = $1, is_edited = TRUE WHERE id = $2`,
            [content.trim(), messageId]
        );

        await client.query('COMMIT'); // Commit the update

        // 3. Fetch full updated message details (outside transaction or with new one)
        const updatedMessage = await fetchFullMessageDetailsById(messageId, client); // Use helper
        if (!updatedMessage) {
             throw new Error(`Критическая ошибка: не удалось получить сообщение ${messageId} после редактирования.`);
        }

        console.log(`Сообщение ${messageId} успешно отредактировано пользователем ${user.id}.`);

        // 4. Emit WebSocket event (sending full updated object)
        socketService.emitToRoom(conversation_id, 'messageUpdated', updatedMessage);
        console.log(`Событие messageUpdated отправлено в комнату ${conversation_id}`);

        // 5. Send full updated message in API response
        res.status(200).json(updatedMessage);

    } catch (err) { // Added catch block
        // Ensure rollback on any error during the transaction
        await client.query('ROLLBACK').catch(rollbackErr => console.error("Rollback failed after error:", rollbackErr));
        console.error(`Ошибка при редактировании сообщения ${messageId}: ${(err as Error).message}`);
        res.status(500).json({ error: 'Ошибка сервера при редактировании сообщения' });
    } finally { // Added finally block
         // Use a check to prevent releasing an already ended client
         if (typeof client.release === 'function') {
            client.release();
         }
    }
};

// --- Delete Message --- (Uses body param, includes transaction)
export const deleteMessage = async (req: Request, res: Response): Promise<void> => {
    const { messageId } = req.body; // Get messageId from body
    const user = req.user as AuthenticatedUser;

     if (!user || !user.id) {
         res.status(401).json({ error: 'Пользователь не аутентифицирован' });
         return;
     }
     if (!messageId || typeof messageId !== 'string') {
         res.status(400).json({ error: 'Необходимо указать messageId в теле запроса' });
         return;
     }

    console.log(`Попытка удаления сообщения ${messageId} пользователем ${user.id}`);

    const client = await pool.connect();
    try { // Added try block
        await client.query('BEGIN');

         // Check ownership and get conversation ID, lock the row
         const messageInfo = await client.query(
             `SELECT conversation_id, sender_id FROM messages WHERE id = $1 FOR UPDATE`,
             [messageId]
         );
         if (messageInfo.rowCount === 0) {
             console.warn(`Сообщение ${messageId} не найдено для удаления.`);
             await client.query('ROLLBACK');
             res.status(204).send(); // Treat as success (idempotent)
             return;
         }
         const { conversation_id, sender_id } = messageInfo.rows[0];

         // Check permissions
         if (sender_id !== user.id) { // Corrected variable user.id
             console.warn(`Пользователь ${user.id} не имеет прав на удаление сообщения ${messageId}.`); // Corrected variable user.id
             await client.query('ROLLBACK');
             res.status(403).json({ error: 'Вы не можете удалить это сообщение' });
             return;
         }

        // Perform deletion (assuming ON DELETE CASCADE or manual cleanup)
        await client.query(`DELETE FROM messages WHERE id = $1`, [messageId]);
        console.log(`Сообщение ${messageId} помечено для удаления.`);

        // Add manual cleanup here if needed for files, reads, mentions etc.

        await client.query('COMMIT');
        console.log(`Сообщение ${messageId} и связанные данные успешно удалены.`);

        // Emit WebSocket event
        const websocketPayload = { id: messageId, conversation_id: conversation_id };
        socketService.emitToRoom(conversation_id, 'messageDeleted', websocketPayload);
        console.log(`Событие messageDeleted отправлено в комнату ${conversation_id}`);

        res.status(204).send();

    } catch (err) { // Added catch block
        await client.query('ROLLBACK').catch(rbErr => console.error("Rollback failed:", rbErr));
        console.error(`Ошибка при удалении сообщения ${messageId}: ${(err as Error).message}`);
        res.status(500).json({ error: 'Ошибка сервера при удалении сообщения' });
    } finally { // Added finally block
        if (typeof client.release === 'function') {
           client.release();
        }
    }
}; // Added closing brace for the function

// --- Helper: Check User Participation ---
const isUserParticipant = async (userId: string, conversationId: string, client: PoolClient | typeof pool = pool): Promise<boolean> => {
    const result = await client.query(
        'SELECT 1 FROM conversation_participants WHERE user_id = $1 AND conversation_id = $2',
        [userId, conversationId]
    );
    return result.rowCount !== null && result.rowCount > 0;
};

// --- Forward Messages --- (New Endpoint Logic)
export const forwardMessages = async (req: Request, res: Response): Promise<void> => {
    const { message_ids, target_conversation_ids } = req.body;
    const user = req.user as AuthenticatedUser;

    // Validation
    if (!user || !user.id ) {
        res.status(401).json({ error: 'Пользователь не аутентифицирован или данные пользователя неполны' });
        return;
    }
    if (!Array.isArray(message_ids) || message_ids.length === 0 ||
        !Array.isArray(target_conversation_ids) || target_conversation_ids.length === 0) {
        res.status(400).json({ error: 'Необходимо указать message_ids и target_conversation_ids в виде непустых массивов' });
        return;
    }

    console.log(`Пользователь ${user.id} (${user.username}) пересылает сообщения [${message_ids.join(', ')}] в чаты [${target_conversation_ids.join(', ')}]`);

    const client = await pool.connect();
    const forwardedMessagesMap: { [key: string]: string[] } = {};

    try {
        await client.query('BEGIN');

        // 1. Verify access to targets
        for (const targetConvId of target_conversation_ids) {
            const canAccess = await isUserParticipant(user.id, targetConvId, client);
            if (!canAccess) {
                throw new Error(`Пользователь ${user.id} не имеет доступа к целевому чату ${targetConvId}`);
            }
            forwardedMessagesMap[targetConvId] = [];
        }

        // 2. Process each original message
        for (const originalMessageId of message_ids) {
            // Get original message data
            const originalMsgResult = await client.query(
                `SELECT m.sender_id, m.sender_username, m.content,
                        json_agg(f.*) FILTER (WHERE f.id IS NOT NULL) as files
                 FROM messages m
                 LEFT JOIN files f ON f.message_id = m.id
                 WHERE m.id = $1
                 GROUP BY m.id`,
                [originalMessageId]
            );

            if (originalMsgResult.rowCount === 0) {
                 console.warn(`Исходное сообщение ${originalMessageId} не найдено. Пропуск.`);
                 continue;
            }
            const originalMessage = originalMsgResult.rows[0];
            const originalFiles: any[] = originalMessage.files || [];

            // 3. Forward to each target
            for (const targetConvId of target_conversation_ids) {
                let newFileIds: string[] = [];

                // 3a. Duplicate files
                if (originalFiles.length > 0) {
                    for (const file of originalFiles) {
                        const newFileResult = await client.query(
                           `INSERT INTO files (user_id, message_id, file_name, file_path, file_type, file_size)
                            VALUES ($1, NULL, $2, $3, $4, $5)
                            RETURNING id`,
                           [user.id, file.file_name, file.file_path, file.file_type, file.file_size]
                        );
                        newFileIds.push(newFileResult.rows[0].id);
                    }
                }

                // 3b. Insert new message
                const insertForwarded = await client.query(
                    `INSERT INTO messages (
                        conversation_id, sender_id, sender_username, content,
                        is_forwarded, forwarded_from_user_id, forwarded_from_username, original_message_id
                     )
                     VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7)
                     RETURNING id`,
                    [
                        targetConvId, user.id, user.username, originalMessage.content,
                        originalMessage.sender_id, originalMessage.sender_username, originalMessageId
                    ]
                );
                const newMessageId = insertForwarded.rows[0].id;

                 // 3c. Link new files to new message
                 if (newFileIds.length > 0) {
                     for (const fileId of newFileIds) {
                         await client.query('UPDATE files SET message_id = $1 WHERE id = $2', [newMessageId, fileId]);
                     }
                 }

                // 3d. Mark as read for forwarder
                 await client.query(
                     `INSERT INTO message_reads (message_id, user_id, read_at) VALUES ($1, $2, NOW())
                      ON CONFLICT (message_id, user_id) DO NOTHING`,
                     [newMessageId, user.id]
                 );

                // 3e. Fetch full details for WebSocket emission
                 const fullNewMessage = await fetchFullMessageDetailsById(newMessageId, client);
                 if (!fullNewMessage) {
                    // This really shouldn't happen
                     console.error(`Критическая ошибка: не удалось получить пересланное сообщение ${newMessageId} после создания.`);
                     continue; // Skip emission for this message
                 }

                 fullNewMessage.is_unread = true; // Set unread flag for recipients
                 forwardedMessagesMap[targetConvId].push(newMessageId);

                // 3f. Emit WebSocket event
                socketService.emitToRoom(targetConvId, 'newMessage', fullNewMessage);
                console.log(`Пересланное сообщение ${newMessageId} (оригинал: ${originalMessageId}) отправлено в комнату ${targetConvId}`);
            }
        }

        await client.query('COMMIT');
        console.log(`Пересылка сообщений пользователем ${user.id} успешно завершена.`);
        res.status(200).json({
            success: true,
            forwarded_messages: forwardedMessagesMap
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Ошибка при пересылке сообщений пользователем ${user.id}: ${(err as Error).message}`);
        if ((err as Error).message.includes('не имеет доступа к целевому чату')) {
             res.status(403).json({ success: false, error: (err as Error).message });
        } else {
             res.status(500).json({ success: false, error: 'Ошибка сервера при пересылке сообщений' });
        }
    } finally {
        client.release();
    }
};

// --- Helper: Fetch Full Message Details (Includes Forwarding) ---
const fetchFullMessageDetailsById = async (messageId: string, client: PoolClient | typeof pool = pool): Promise<any | null> => {
    // Query assumes forwarding columns exist: is_forwarded, forwarded_from_user_id, forwarded_from_username, original_message_id
    const result = await client.query(
             `
             WITH message_files AS (
                 SELECT
                     message_id,
                     json_agg(
                         json_build_object(
                             'id', f.id,
                             'file_name', f.file_name,
                             'file_path', f.file_path,
                             'file_type', f.file_type,
                             'file_size', f.file_size,
                             'created_at', f.created_at::text,
                             'download_url', '/api/files/download/' || f.id::text
                         ) ORDER BY f.created_at
                     ) as files
                 FROM files f
                 GROUP BY message_id
             ),
             message_reads_agg AS (
                  SELECT
                     message_id,
                     json_agg(
                         json_build_object(
                             'contact_id', u.id,
                             'username', u.username,
                             'email', u.email,
                             'read_at', mr.read_at::text,
                             'avatarPath', ua.file_path -- Reader relative avatar path
                         ) ORDER BY mr.read_at
                     ) as read_by_users
                 FROM message_reads mr
                 JOIN users u ON u.id = mr.user_id
                 GROUP BY message_id
             )
             SELECT
                 m.id,
                 m.conversation_id,
                 m.sender_id,
                 m.sender_username,
                 m.content,
                 m.created_at::text AS created_at,
                 m.is_edited,
                 m.replied_to_message_id,
                 replied_msg.sender_username AS replied_to_sender_username,
                 CASE
                     WHEN replied_msg.content IS NOT NULL THEN LEFT(replied_msg.content, 50) || CASE WHEN LENGTH(replied_msg.content) > 50 THEN '...' ELSE '' END
                     WHEN replied_file.file_name IS NOT NULL THEN 'Файл: ' || replied_file.file_name
                     ELSE NULL
                 END AS replied_to_content_preview,
            m.is_forwarded,
            m.forwarded_from_user_id,
            m.forwarded_from_username,
            m.original_message_id,
                 COALESCE(mra.read_by_users, '[]'::json) AS read_by_users,
                 COALESCE(mf.files, '[]'::json) AS files
             FROM messages m
             LEFT JOIN message_files mf ON mf.message_id = m.id
             LEFT JOIN message_reads_agg mra ON mra.message_id = m.id
             LEFT JOIN messages replied_msg ON replied_msg.id = m.replied_to_message_id
             LEFT JOIN (SELECT message_id, file_name FROM files LIMIT 1) replied_file ON replied_file.message_id = replied_msg.id
             WHERE m.id = $1
             `,
        [messageId]
    );

    if (result.rowCount === null || result.rowCount === 0) {
        return null;
    }

    const message = result.rows[0];
    // Format dates
    message.created_at = new Date(message.created_at).toISOString();
    message.read_by_users = message.read_by_users.map((reader: any) => ({
             ...reader,
             read_at: new Date(reader.read_at).toISOString()
         }));
    message.files = message.files.map((file: any) => ({
            ...file,
            created_at: new Date(file.created_at).toISOString()
        }));
    // Remove absolute URL generation
    // message.senderAvatarUrl = getAbsoluteUrl(message.senderAvatarPath);
    // message.read_by_users = message.read_by_users.map((reader: any) => ({
    //     ...reader,
    //     read_at: new Date(reader.read_at).toISOString(),
    //     avatarUrl: getAbsoluteUrl(reader.avatarPath),
    //     avatarPath: undefined
    // }));
    // message.files = message.files.map((file: any) => ({
    //     ...file,
    //     created_at: new Date(file.created_at).toISOString()
    // }));
    // message.senderAvatarPath = undefined; // Keep original path
    return message;
};
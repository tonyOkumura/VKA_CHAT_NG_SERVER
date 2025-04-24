import { Request, Response } from 'express';
import pool from '../models/db';
import * as socketService from '../services/socketService'; // Импортируем socketService

// Тип для данных из req.user (предполагая, что middleware добавляет пользователя)
interface AuthenticatedUser {
    id: string;
    // другие поля пользователя, если они есть
}

// Добавляем новые поля в запрос
export const fetchAllMessagesByConversationId = async (req: Request, res: Response): Promise<void> => {
    const { conversation_id } = req.params; // Получаем ID разговора из параметров запроса
    let userId: string | null = null; // Явное указание типа
    if (req.user) {
        userId = (req.user as AuthenticatedUser).id; // Предполагаем, что ID пользователя доступен через req.user от middleware аутентификации
    }

    console.log(`Получение сообщений для разговора: ${conversation_id}, пользователь: ${userId || 'Анонимный'}`);

    try {
        // Начинаем транзакцию
        // await pool.query('BEGIN'); // Убрал транзакцию, т.к. отметка прочитанных идет после ответа

        // Получаем все сообщения с информацией об ответе, прочтении и файлах
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
                            'read_at', mr.read_at::text -- Convert read_at to text (ISO 8601)
                        ) ORDER BY mr.read_at
                    ) as read_by_users
                FROM message_reads mr
                JOIN users u ON u.id = mr.user_id
                GROUP BY message_id
            )
            SELECT
                m.id,
                m.content,
                m.sender_id,
                m.sender_username, -- Имя отправителя на момент отправки
                -- u.username AS sender_username_current, -- Текущее имя отправителя (если нужно)
                m.conversation_id,
                m.created_at::text AS created_at, -- Convert message created_at to text (ISO 8601)
                m.is_edited,
                m.replied_to_message_id,
                -- Данные об исходном сообщении для ответа
                replied_msg.sender_username AS replied_to_sender_username,
                -- Генерируем превью контента (например, первые 50 символов)
                CASE
                    WHEN replied_msg.content IS NOT NULL THEN LEFT(replied_msg.content, 50) || CASE WHEN LENGTH(replied_msg.content) > 50 THEN '...' ELSE '' END
                    WHEN replied_file.file_name IS NOT NULL THEN 'Файл: ' || replied_file.file_name
                    ELSE NULL
                END AS replied_to_content_preview,
                -- Прочитано ли сообщение текущим пользователем (если он авторизован)
                CASE
                    WHEN $2::UUID IS NOT NULL THEN EXISTS (
                        SELECT 1
                        FROM message_reads mr
                        WHERE mr.message_id = m.id
                        AND mr.user_id = $2::UUID
                    )
                    ELSE FALSE -- Для неавторизованных всегда false
                END AS is_read_by_current_user,
                -- Получаем массив объектов прочитавших пользователей
                 COALESCE(mra.read_by_users, '[]'::json) AS read_by_users,
                -- Получаем массив объектов с данными о файлах
                COALESCE(mf.files, '[]'::json) AS files
            FROM messages m
            -- JOIN users u ON u.id = m.sender_id -- Убрали JOIN, т.к. username берем из m.sender_username
            LEFT JOIN message_files mf ON mf.message_id = m.id
            LEFT JOIN message_reads_agg mra ON mra.message_id = m.id
            -- Присоединяем данные об отвеченном сообщении
            LEFT JOIN messages replied_msg ON replied_msg.id = m.replied_to_message_id
            LEFT JOIN (SELECT message_id, file_name FROM files LIMIT 1) replied_file ON replied_file.message_id = replied_msg.id
            WHERE m.conversation_id = $1
            ORDER BY m.created_at ASC
            `,
            [conversation_id, userId] // Передаем userId как второй параметр
        );

        // Форматируем даты и добавляем is_unread для текущего пользователя
        const formattedMessages = messagesResult.rows.map(msg => ({
            ...msg,
            created_at: new Date(msg.created_at).toISOString(),
            read_by_users: msg.read_by_users.map((reader: any) => ({
                ...reader,
                read_at: new Date(reader.read_at).toISOString()
            })),
            files: msg.files.map((file: any) => ({
                ...file,
                created_at: new Date(file.created_at).toISOString()
            })),
            // is_unread вычисляем на клиенте на основе read_by_users или is_read_by_current_user
            is_unread: userId ? !msg.is_read_by_current_user && msg.sender_id !== userId : false
        }));

        // Если пользователь авторизован, отмечаем все полученные сообщения как прочитанные для него
        // (Это произойдет только после успешного получения сообщений)
        if (userId && formattedMessages.length > 0) {
            const messageIds = formattedMessages.map(msg => msg.id);
            try {
                await pool.query(
                    `
                    INSERT INTO message_reads (message_id, user_id, read_at)
                    SELECT unnest($1::uuid[]), $2, NOW()
                    ON CONFLICT (message_id, user_id) DO NOTHING
                    `,
                    [messageIds, userId]
                );
                 console.log(`Сообщения [${messageIds.join(', ')}] в разговоре ${conversation_id} отмечены как прочитанные для пользователя ${userId}`);

                 // Отправляем событие о прочтении через WebSocket всем участникам
                const markReadPayload = {
                    conversation_id,
                    user_id: userId,
                    message_ids: messageIds,
                    read_at: new Date().toISOString()
                };
                socketService.emitToRoom(conversation_id, 'messagesRead', markReadPayload);

            } catch (readError) {
                 console.error(`Ошибка при отметке сообщений как прочитанных для пользователя ${userId} в разговоре ${conversation_id}:`, readError);
                 // Не прерываем выполнение, просто логируем ошибку
            }
        }

        // Подтверждаем транзакцию - убрал, т.к. транзакцию убрал выше
        // await pool.query('COMMIT');

        console.log(`Сообщения успешно получены для разговора: ${conversation_id}`);
        // Не переворачиваем, так как ORDER BY ASC
        res.json(formattedMessages);
    } catch (err) {
        // Откатываем транзакцию в случае ошибки - убрал
        // await pool.query('ROLLBACK');
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
    fileId?: string,
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

        // Если есть файл, связываем его с сообщением
        if (fileId) {
            await pool.query(
                `UPDATE files SET message_id = $1 WHERE id = $2`,
                [savedMessageId, fileId]
            );
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
                             'read_at', mr.read_at::text -- Convert read_at to text (ISO 8601)
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
                 m.sender_username, -- Имя отправителя на момент отправки
                 m.content,
                 m.created_at::text AS created_at,
                 m.is_edited,
                 m.replied_to_message_id,
                 -- Данные об исходном сообщении для ответа
                 replied_msg.sender_username AS replied_to_sender_username,
                 CASE
                     WHEN replied_msg.content IS NOT NULL THEN LEFT(replied_msg.content, 50) || CASE WHEN LENGTH(replied_msg.content) > 50 THEN '...' ELSE '' END
                     WHEN replied_file.file_name IS NOT NULL THEN 'Файл: ' || replied_file.file_name
                     ELSE NULL
                 END AS replied_to_content_preview,
                 -- Получаем массив объектов прочитавших пользователей (здесь будет только отправитель)
                 COALESCE(mra.read_by_users, '[]'::json) AS read_by_users,
                 -- Получаем массив объектов с данными о файлах
                 COALESCE(mf.files, '[]'::json) AS files
             FROM messages m
             LEFT JOIN message_files mf ON mf.message_id = m.id
             LEFT JOIN message_reads_agg mra ON mra.message_id = m.id
             LEFT JOIN messages replied_msg ON replied_msg.id = m.replied_to_message_id
             LEFT JOIN (SELECT message_id, file_name FROM files LIMIT 1) replied_file ON replied_file.message_id = replied_msg.id
             WHERE m.id = $1
             `,
             [savedMessageId]
         );


        console.log(`Сообщение ${savedMessageId} успешно сохранено для разговора: ${conversationId}`);

        const finalMessage = fullMessageResult.rows[0];
        // Форматируем даты
        finalMessage.created_at = new Date(finalMessage.created_at).toISOString();
         finalMessage.read_by_users = finalMessage.read_by_users.map((reader: any) => ({
             ...reader,
             read_at: new Date(reader.read_at).toISOString()
         }));
        finalMessage.files = finalMessage.files.map((file: any) => ({
            ...file,
            created_at: new Date(file.created_at).toISOString()
        }));
        // Добавляем is_unread: true (кроме отправителя, это будет обработано на клиенте или при отправке)
        finalMessage.is_unread = true; // Для отправки всем, кроме отправителя

        return finalMessage; // Возвращаем полный объект сообщения

    } catch (err) {
        // Откатываем транзакцию в случае ошибки
        await pool.query('ROLLBACK');
        console.error(`Не удалось сохранить сообщение - ${(err as Error).message}`);
        throw new Error(`Не удалось сохранить сообщение: ${(err as Error).message}`);
    }
};

// Новая функция для редактирования сообщения
export const editMessage = async (req: Request, res: Response) => {
    // Получаем messageId и content из тела запроса
    const { messageId, content } = req.body;
    const userId = (req.user as AuthenticatedUser).id;

    // Валидация входных данных
    if (!messageId || typeof messageId !== 'string') {
        res.status(400).json({ error: 'Необходимо указать messageId в теле запроса' });
        return;
    }
    if (!content || typeof content !== 'string' || content.trim() === '') {
        res.status(400).json({ error: 'Текст сообщения не может быть пустым' });
        return;
    }

     console.log(`Попытка редактирования сообщения: ${messageId} пользователем ${userId}`);

    try {
        // Обновляем сообщение и проверяем, что оно принадлежит пользователю
        const updateResult = await pool.query(
            `
            UPDATE messages
            SET content = $1, is_edited = TRUE
            WHERE id = $2 AND sender_id = $3
            RETURNING id, conversation_id
            `, // Возвращаем только ID и ID чата
            [content.trim(), messageId, userId]
        );

        if (updateResult.rowCount === 0) {
             const checkExist = await pool.query('SELECT sender_id FROM messages WHERE id = $1', [messageId]);
             if (checkExist.rowCount === 0) {
                 console.warn(`Сообщение ${messageId} не найдено для редактирования.`);
                 res.status(404).json({ error: 'Сообщение не найдено' });
                 return;
             } else {
                 console.warn(`Пользователь ${userId} не имеет прав на редактирование сообщения ${messageId}.`);
                 res.status(403).json({ error: 'Вы не можете редактировать это сообщение' });
                 return;
             }
        }

        const { id: updatedMessageId, conversation_id } = updateResult.rows[0];
        console.log(`Сообщение ${updatedMessageId} успешно отредактировано пользователем ${userId}.`);

        // Получаем ПОЛНУЮ информацию об обновленном сообщении для ответа API
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
                             'read_at', mr.read_at::text -- Convert read_at to text (ISO 8601)
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
                 COALESCE(mra.read_by_users, '[]'::json) AS read_by_users,
                 COALESCE(mf.files, '[]'::json) AS files
             FROM messages m
             LEFT JOIN message_files mf ON mf.message_id = m.id
             LEFT JOIN message_reads_agg mra ON mra.message_id = m.id
             LEFT JOIN messages replied_msg ON replied_msg.id = m.replied_to_message_id
             LEFT JOIN (SELECT message_id, file_name FROM files LIMIT 1) replied_file ON replied_file.message_id = replied_msg.id
             WHERE m.id = $1
             `,
             [updatedMessageId]
         );

         if (fullMessageResult.rowCount === 0) {
            console.error(`Критическая ошибка: Не удалось найти обновленное сообщение ${updatedMessageId} после редактирования.`);
            res.status(500).json({ error: 'Ошибка сервера при получении обновленного сообщения' });
            return;
         }

        const fullUpdatedMessage = fullMessageResult.rows[0];
        // Форматируем даты
        fullUpdatedMessage.created_at = new Date(fullUpdatedMessage.created_at).toISOString();
        fullUpdatedMessage.read_by_users = fullUpdatedMessage.read_by_users.map((reader: any) => ({
             ...reader,
             read_at: new Date(reader.read_at).toISOString()
         }));
        fullUpdatedMessage.files = fullUpdatedMessage.files.map((file: any) => ({
            ...file,
            created_at: new Date(file.created_at).toISOString()
        }));

        // Готовим payload для WebSocket (частичное обновление)
        const websocketPayload = {
            id: fullUpdatedMessage.id,
            conversation_id: fullUpdatedMessage.conversation_id,
            content: fullUpdatedMessage.content,
            is_edited: fullUpdatedMessage.is_edited,
        };

        // Отправляем событие через WebSocket всем участникам чата
        socketService.emitToRoom(conversation_id, 'messageUpdated', websocketPayload);
        console.log(`Событие messageUpdated отправлено в комнату ${conversation_id}`);

        // Отправляем ПОЛНЫЙ объект сообщения в ответе API
        res.status(200).json(fullUpdatedMessage);

    } catch (err) {
        console.error(`Ошибка при редактировании сообщения ${messageId}: ${(err as Error).message}`);
        res.status(500).json({ error: 'Ошибка сервера при редактировании сообщения' });
    }
};

// Новая функция для удаления сообщения
export const deleteMessage = async (req: Request, res: Response): Promise<void> => {
    const { messageId } = req.body;
    const userId = (req.user as AuthenticatedUser).id;

    console.log(`Попытка удаления сообщения: ${messageId} пользователем ${userId}`);

    try {
         // Сначала получаем ID чата, чтобы отправить событие, и проверяем права
         const messageInfo = await pool.query(
             `SELECT conversation_id, sender_id FROM messages WHERE id = $1`,
             [messageId]
         );

         if (messageInfo.rowCount === 0) {
             console.warn(`Сообщение ${messageId} не найдено для удаления.`);
             // Отправляем 204, даже если не найдено, чтобы клиент считал операцию успешной
             res.status(204).send();
             return;
         }

         const { conversation_id, sender_id } = messageInfo.rows[0];

         // Проверяем, является ли пользователь отправителем сообщения
         // TODO: Добавить проверку на права администратора чата, если это необходимо
         if (sender_id !== userId) {
             console.warn(`Пользователь ${userId} не имеет прав на удаление сообщения ${messageId}.`);
             res.status(403).json({ error: 'Вы не можете удалить это сообщение' });
             return;
         }

        // Удаляем сообщение
        const deleteResult = await pool.query(
            `DELETE FROM messages WHERE id = $1 AND sender_id = $2`,
            [messageId, userId]
        );

        // deleteResult.rowCount здесь не так важен, так как мы уже проверили существование и права

        console.log(`Сообщение ${messageId} успешно удалено пользователем ${userId}.`);

        // Готовим payload для WebSocket
        const websocketPayload = {
            id: messageId,
            conversation_id: conversation_id
        };

        // Отправляем событие через WebSocket всем участникам чата
        socketService.emitToRoom(conversation_id, 'messageDeleted', websocketPayload);
        console.log(`Событие messageDeleted отправлено в комнату ${conversation_id}`);

        // Отправляем успешный ответ клиенту
        res.status(204).send();

    } catch (err) {
        console.error(`Ошибка при удалении сообщения ${messageId}: ${(err as Error).message}`);
        res.status(500).json({ error: 'Ошибка сервера при удалении сообщения' });
    }
};
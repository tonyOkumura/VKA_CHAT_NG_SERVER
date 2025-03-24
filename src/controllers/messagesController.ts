import { Request, Response } from 'express';
import pool from '../models/db';

export const fetchAllMessagesByConversationId = async (req: Request, res: Response): Promise<void> => {
    const { conversation_id } = req.params; // Получаем ID разговора из параметров запроса
    let userId = null;
    if (req.user) {
        userId = req.user.id; // Предполагаем, что ID пользователя доступен через req.user от middleware аутентификации
    }

    console.log(`Получение сообщений для разговора: ${conversation_id}`);

    try {
        // Начинаем транзакцию
        await pool.query('BEGIN');

        // Получаем все сообщения с информацией о прочтении
        const messagesResult = await pool.query(
            `
            SELECT 
                m.id, 
                m.content, 
                m.sender_id,
                u.username AS sender_username,
                m.conversation_id, 
                m.created_at,
                -- Проверяем, прочитано ли сообщение кем-то, кроме отправителя
                EXISTS (
                    SELECT 1 
                    FROM message_reads mr 
                    WHERE mr.message_id = m.id 
                    AND mr.user_id != m.sender_id
                ) AND NOT EXISTS (
                    SELECT 1 
                    FROM message_reads mr 
                    WHERE mr.message_id = m.id 
                    AND mr.user_id = m.sender_id
                ) AS is_unread,
                -- Получаем массив объектов с данными прочитавших пользователей, включая read_at
                COALESCE(
                    (SELECT json_agg(
                        json_build_object(
                            'contact_id', u.id,
                            'username', u.username,
                            'email', u.email,
                            'read_at', mr.read_at
                        )
                    )
                    FROM message_reads mr
                    JOIN users u ON u.id = mr.user_id
                    WHERE mr.message_id = m.id),
                    '[]'::json
                ) AS read_by_users
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.conversation_id = $1
            ORDER BY m.created_at ASC
            `,
            [conversation_id]
        );

        // Если пользователь авторизован, отмечаем все сообщения как прочитанные для него
        if (userId) {
            await pool.query(
                `
                INSERT INTO message_reads (message_id, user_id, read_at)
                SELECT m.id, $1, NOW()
                FROM messages m
                WHERE m.conversation_id = $2
                AND NOT EXISTS (
                    SELECT 1 
                    FROM message_reads mr 
                    WHERE mr.message_id = m.id 
                    AND mr.user_id = $1
                )
                `,
                [userId, conversation_id]
            );
        }

        // Подтверждаем транзакцию
        await pool.query('COMMIT');

        console.log(`Сообщения успешно получены и отмечены как прочитанные для разговора: ${conversation_id}`);
        res.json(messagesResult.rows.reverse());
    } catch (err) {
        // Откатываем транзакцию в случае ошибки
        await pool.query('ROLLBACK');
        console.error(`Не удалось получить сообщения для разговора ${conversation_id} - ${(err as Error).message}`);
        res.status(500).json({ error: 'Не удалось получить сообщения' });
    }
};
export const saveMessage = async (conversationId: string, senderId: string, content: string, mentions: string[] = []) => {
    console.log(`Сохранение сообщения для разговора: ${conversationId}, отправитель: ${senderId}`);

    try {
        // Начинаем транзакцию
        await pool.query('BEGIN');

        // Сохраняем сообщение
        const messageResult = await pool.query(
            `
            INSERT INTO messages (conversation_id, sender_id, content)
            VALUES ($1, $2, $3)
            RETURNING *
            `,
            [conversationId, senderId, content]
        );
        const savedMessage = messageResult.rows[0];

        // Отмечаем сообщение как прочитанное для отправителя
        await pool.query(
            `
            INSERT INTO message_reads (message_id, user_id, read_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (message_id, user_id) DO NOTHING
            `,
            [savedMessage.id, senderId]
        );

        // Добавляем упоминания, если они есть
        if (mentions.length > 0) {
            const mentionValues = mentions.map(mentionedUserId => 
                `('${savedMessage.id}', '${mentionedUserId}', NOW())`
            ).join(',');
            
            await pool.query(
                `
                INSERT INTO message_mentions (message_id, user_id, created_at)
                VALUES ${mentionValues}
                ON CONFLICT (message_id, user_id) DO NOTHING
                `
            );
        }

        // Подтверждаем транзакцию
        await pool.query('COMMIT');

        console.log(`Сообщение успешно сохранено для разговора: ${conversationId}`);
        return savedMessage;
    } catch (err) {
        // Откатываем транзакцию в случае ошибки
        await pool.query('ROLLBACK');
        console.error(`Не удалось сохранить сообщение - ${(err as Error).message}`);
        throw new Error('Не удалось сохранить сообщение');
    }
};
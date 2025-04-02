import { json } from "stream/consumers";
import pool from "../models/db";
import { Request, Response } from "express";

export const fetchAllConversationsByUserId = async (req: Request, res: Response) => {
    let userId = null;
    if (req.user) {
        userId = req.user.id;
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
                SELECT 
                    conversation_id,
                    content,
                    created_at,
                    sender_id,
                    sender_username
                FROM messages
                WHERE (conversation_id, created_at) IN (
                    SELECT conversation_id, MAX(created_at)
                    FROM messages
                    GROUP BY conversation_id
                )
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
                        )
                    ) AS participants
                FROM conversation_participants cp
                JOIN users u ON u.id = cp.user_id
                GROUP BY cp.conversation_id
            ),
            unread_counts AS (
                SELECT 
                    conversation_id,
                    COUNT(*) FILTER (WHERE NOT EXISTS (
                        SELECT 1 FROM message_reads mr 
                        WHERE mr.message_id = m.id 
                        AND mr.user_id = $1
                    )) AS unread_count
                FROM messages m
                GROUP BY conversation_id
            )
            SELECT 
                c.id AS conversation_id,
                dn.conversation_name,
                c.is_group_chat,
                c.name AS group_name,
                u.username AS admin_name,
                u.id AS admin_id,
                lm.content AS last_message,
                lm.created_at AS last_message_time,
                lm.sender_id AS last_message_sender_id,
                lm.sender_username AS last_message_sender_username,
                COALESCE(uc.unread_count, 0) AS unread_count,
                pi.participants,
                c.created_at AS conversation_created_at
            FROM conversations c
            JOIN dialog_names dn ON dn.conversation_id = c.id
            JOIN users u ON u.id = c.admin_id
            LEFT JOIN last_messages lm ON lm.conversation_id = c.id
            LEFT JOIN unread_counts uc ON uc.conversation_id = c.id
            LEFT JOIN participants_info pi ON pi.conversation_id = c.id
            JOIN conversation_participants cp ON cp.conversation_id = c.id
            WHERE cp.user_id = $1
            ORDER BY lm.created_at DESC NULLS LAST
            `,
            [userId]
        );

        console.log(`Чаты успешно получены для пользователя: ${userId}`);
        res.json(result.rows);
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
        const values = allParticipants.map(participantId => `('${conversation_id}', '${participantId}')`).join(',');
        
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
    const { conversation_id, participant_id } = req.body;

    console.log(`Adding participant: ${participant_id} to conversation: ${conversation_id}`);

    try {
        // Check if the conversation is a group chat
        const conversation = await pool.query(
            `SELECT is_group_chat FROM conversations WHERE id = $1`,
            [conversation_id]
        );

        if (conversation.rowCount === 0) {
            console.log('Conversation not found');
            return res.status(404).json({ error: 'Conversation not found' });
        }

        if (!conversation.rows[0].is_group_chat) {
            console.log('Cannot add participant to a non-group chat');
            return res.status(400).json({ error: 'Cannot add participant to a non-group chat' });
        }

        const result = await pool.query(
            `
            INSERT INTO conversation_participants (conversation_id, user_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING;
            `,
            [conversation_id, participant_id]
        );

        if (result.rowCount === 0) {
            console.log('Participant already exists in the conversation');
            return res.status(409).json({ error: 'Participant already exists in the conversation' });
        }

        console.log(`Participant added successfully to conversation: ${conversation_id}`);
        res.status(201).json({ message: 'Participant added successfully' });
    } catch (error) {
        console.error('Error adding participant to conversation:', error);
        res.status(500).json({ error: 'Failed to add participant to conversation' });
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
        throw error; // Передаем ошибку дальше для обработки в вызывающем коде
    }
};

import { json } from "stream/consumers";
import pool from "../models/db";
import { Request, Response } from "express";

export const fetchAllConversationsByUserId = async (req: Request, res: Response) => {
    let userId = null;
    if (req.user) {
        userId = req.user.id;
    }

    console.log(`Fetching conversations for user: ${userId}`);

    try {
        const result = await pool.query(
            `
            SELECT 
                c.id AS conversation_id, 
                c.name AS conversation_name,
                c.is_group_chat,
                u.username AS admin_name,
                m.content AS last_message, 
                m.created_at AS last_message_time,
                cp.unread_count
            FROM conversations c
            JOIN users u ON u.id = c.admin_id
            LEFT JOIN LATERAL (
                SELECT content, created_at
                FROM messages
                WHERE conversation_id = c.id
                ORDER BY created_at DESC
                LIMIT 1
            ) m ON true
            JOIN conversation_participants cp ON cp.conversation_id = c.id
            WHERE cp.user_id = $1
            ORDER BY m.created_at DESC
            `,
            [userId]
        );

        console.log(`Conversations fetched successfully for user: ${userId}`);
        res.json(result.rows);
    } catch (e) {
        const error = e as Error;
        console.error(`Error fetching conversations for user: ${userId} - Error: ${error.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
};

export const checkOrCreateConversation = async (req: Request, res: Response): Promise<any> => {
    let userId = null;
    if (req.user) {
        userId = req.user.id;
    }
    const { contact_id, is_group_chat, name } = req.body;

    try {
        let existingConversation;
        if (is_group_chat) {
            existingConversation = await pool.query(
                `
                SELECT id FROM conversations
                WHERE name = $1 AND is_group_chat = TRUE
                LIMIT 1;
                `,
                [name]
            );
        } else {
            existingConversation = await pool.query(
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
                LIMIT 1;
                `,
                [userId, contact_id]
            );
        }

        if (existingConversation.rowCount !== null && existingConversation.rowCount > 0) {
            return res.json({ conversationId: existingConversation.rows[0].id });
        }

        const newConversation = await pool.query(
            `
            INSERT INTO conversations (name, is_group_chat, admin_id)
            VALUES ($1, $2, $3)
            RETURNING id;
            `,
            [name, is_group_chat, userId]
        );

        const conversationId = newConversation.rows[0].id;

        await pool.query(
            `
            INSERT INTO conversation_participants (conversation_id, user_id)
            VALUES ($1, $2), ($1, $3);
            `,
            [conversationId, userId, contact_id]
        );

        res.json({ conversationId });
    } catch (error) {
        console.error('Error checking or creating conversation:', error);
        res.status(500).json({ error: 'Failed to check or create conversation' });
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
